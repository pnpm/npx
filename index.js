'use strict'

const Buffer = require('safe-buffer').Buffer
const promisify = require('./util.js').promisify

const child = require('./child')
const enquirer = require('enquirer')
const fs = require('fs')
const parseArgs = require('./parse-args.js')
const path = require('path')
const which = promisify(require('which'))

module.exports = npx
module.exports.parseArgs = parseArgs
async function npx (argv) {
  const shell = argv['shell-auto-fallback']
  if (shell || shell === '') {
    const fallback = require('./auto-fallback.js')(
      shell, process.env.SHELL, argv
    )
    if (fallback) {
      return console.log(fallback)
    } else {
      process.exitCode = 1
      return
    }
  }

  if (!argv.call && (!argv.command || !argv.package)) {
    !argv.q && console.error(Y()`\nERROR: You must supply a command.\n`)
    !argv.q && parseArgs.showHelp()
    process.exitCode = 1
    return
  }

  const startTime = Date.now()

  try {
  // First, we look to see if we're inside an npm project, and grab its
  // bin path. This is exactly the same as running `$ npm bin`.
    const local = await localBinPath(process.cwd())
    if (local) {
      // Local project paths take priority. Go ahead and prepend it.
      process.env.PATH = `${local}${path.delimiter}${process.env.PATH}`
    }
    const args = await Promise.all([
      // Figuring out if a command exists, early on, lets us maybe
      // short-circuit a few things later. This bit here primarily benefits
      // calls like `$ npx foo`, where we might just be trying to invoke
      // a single command and use whatever is already in the path.
      argv.command && getExistingPath(argv.command, argv),
      // The `-c` flag involves special behavior when used: in this case,
      // we take a bit of extra time to pick up npm's full lifecycle script
      // environment (so you can use `$npm_package_xxxxx` and company).
      // Without that flag, we just use the current env.
      argv.call && local && getEnv(argv)
    ])
    let existing = args[0]
    const newEnv = args[1]
    if (newEnv) {
      // NOTE - we don't need to manipulate PATH further here, because
      //        npm has already done so. And even added the node-gyp path!
      Object.assign(process.env, newEnv)
    }
    if ((!existing && !argv.call) || argv.packageRequested) {
      if (argv.no === true) {
        console.log(`${argv.package} is not found`)
        process.exit(1)
      }
      if (argv.yes !== true) {
        const { allowInstall } = await enquirer.prompt({
          type: 'confirm',
          initial: true,
          name: 'allowInstall',
          message: `Install the following package: ${argv.package}?`,
        })
        if (allowInstall === false) {
          console.log('Cancelled')
          process.exit(1)
        }
      }
      // Some npm packages need to be installed. Let's install them!
      const results = await ensurePackages(argv.package, argv)
      if (results && results.added && results.updated && !argv.q) {
        console.error(Y()`npx: installed ${
          results.added.length + results.updated.length
        } in ${(Date.now() - startTime) / 1000}s`)
      }
      if (
        argv.command &&
        !existing &&
        !argv.packageRequested &&
        argv.package.length === 1
      ) {
        let bins
        try {
          bins = await fs.promises.readdir(results.bin)
        } catch (err) {
          if (err.code === 'ENOENT') {
            throw new Error(Y()`command not found: ${argv.command}`)
          } else {
            throw err
          }
        }
        if (process.platform === 'win32') {
          bins = bins.filter(b => b !== 'etc' && b !== 'node_modules')
        }
        if (bins.length < 1) {
          throw new Error(Y()`command not found: ${argv.command}`)
        }
        const cmd = new RegExp(`^${argv.command}(?:\\.cmd)?$`, 'i')
        const matching = bins.find(b => b.match(cmd))
        existing = path.resolve(results.bin, bins[matching] || bins[0])
      }
    }
    return await execCommand(existing, argv)
  } catch (err) {
    !argv.q && console.error(err.message)
    process.exitCode = err.exitCode || 1
  }
}

module.exports._localBinPath = localBinPath
function localBinPath (cwd) {
  return require('./get-prefix.js')(cwd).then(prefix => {
    return prefix && path.join(prefix, 'node_modules', '.bin')
  })
}

module.exports._getEnv = getEnv
function getEnv (opts) {
  const args = ['run', 'env', '--parseable']
  return findNodeScript(opts.npm, { isLocal: true }).then(npmPath => {
    if (npmPath) {
      args.unshift(child.escapeArg(opts.npm))
      return process.argv[0]
    } else {
      return opts.npm
    }
  }).then(npmPath => {
    return child.exec(npmPath, args)
  }).then(require('dotenv').parse)
}

module.exports._ensurePackages = ensurePackages
function ensurePackages (specs, opts) {
  return (
    opts.cache ? Promise.resolve(opts.cache) : getNpmCache(opts)
  ).then(cache => {
    const prefix = path.join(cache, '_npx', process.pid.toString())
    const bins = process.platform === 'win32'
      ? prefix
      : path.join(prefix, 'bin')
    fs.mkdirSync(prefix, { recursive: true })
    const rimraf = require('@zkochan/rimraf')
    process.on('exit', () => {
      try {
        fs.rmdirSync(prefix, {
          recursive: true,
          maxRetries: 3,
        })
      } catch (err) { }
    })
    return rimraf(bins).then(() => {
      return installPackages(specs, prefix, opts)
    }).then(info => {
      // This will make temp bins _higher priority_ than even local bins.
      // This is intentional, since npx assumes that if you went through
      // the trouble of doing `-p`, you're rather have that one. Right? ;)
      process.env.PATH = `${bins}${path.delimiter}${process.env.PATH}`
      if (!info) { info = {} }
      info.prefix = prefix
      info.bin = bins
      return info
    })
  })
}

module.exports._getExistingPath = getExistingPath
function getExistingPath (command, opts) {
  if (opts.isLocal) {
    return Promise.resolve(command)
  } else if (
    opts.cmdHadVersion || opts.packageRequested || opts.ignoreExisting
  ) {
    return Promise.resolve(false)
  } else {
    return which(command).catch(err => {
      if (err.code === 'ENOENT') {
        if (opts.install === false) {
          err.exitCode = 127
          throw err
        }
      } else {
        throw err
      }
    })
  }
}

module.exports._getNpmCache = getNpmCache
function getNpmCache (opts) {
  const args = ['config', 'get', 'cache', '--parseable']
  if (opts.userconfig) {
    args.push('--userconfig', child.escapeArg(opts.userconfig, true))
  }
  return findNodeScript(opts.npm, { isLocal: true }).then(npmPath => {
    if (npmPath) {
      // This one is NOT escaped as a path because it's handed to Node.
      args.unshift(child.escapeArg(opts.npm))
      return process.argv[0]
    } else {
      return opts.npm
    }
  }).then(npmPath => {
    return child.exec(npmPath, args)
  }).then(cache => cache.trim())
}

module.exports._buildArgs = buildArgs
function buildArgs (specs, prefix, opts) {
  const args = ['install'].concat(specs)
  args.push('--global', '--dir', prefix)
  if (opts.userconfig) args.push('--userconfig', opts.userconfig)
  // pnpm does not support these flags, so omitting
  // args.push('--loglevel', 'error', '--json')

  return args
}

module.exports._installPackages = installPackages
function installPackages (specs, prefix, opts) {
  const args = buildArgs(specs, prefix, opts)
  return findNodeScript(opts.npm, { isLocal: true }).then(npmPath => {
    if (npmPath) {
      args.unshift(
        process.platform === 'win32'
          ? child.escapeArg(opts.npm)
          : opts.npm
      )
      return process.argv[0]
    } else {
      return opts.npm
    }
  }).then(npmPath => {
    return process.platform === 'win32' ? child.escapeArg(npmPath, true) : npmPath
  }).then(npmPath => {
    return child.spawn(npmPath, args, {
      stdio: opts.installerStdio
        ? opts.installerStdio
        : [0, 'pipe', opts.q ? 'ignore' : 2]
    }).then(deets => {
      try {
        return deets.stdout ? JSON.parse(deets.stdout) : null
      } catch (e) { }
    }, err => {
      if (err.exitCode) {
        err.message = Y()`Install for ${specs} failed with code ${err.exitCode}`
      }
      throw err
    })
  })
}

module.exports._execCommand = execCommand
function execCommand (_existing, argv) {
  return findNodeScript(_existing, argv).then(existing => {
    const argvCmdOpts = argv.cmdOpts || []
    if (existing && !argv.alwaysSpawn && !argv.nodeArg && !argv.shell && existing !== process.argv[1]) {
      const Module = require('module')
      // let it take over the process. This means we can skip node startup!
      if (!argv.noYargs) {
        // blow away built-up yargs crud
        require('yargs').reset()
      }
      process.argv = [
        process.argv[0], // Current node binary
        existing // node script path. `runMain()` will set this as the new main
      ].concat(argvCmdOpts) // options for the cmd itself
      Module.runMain() // ✨MAGIC✨. Sorry-not-sorry
    } else if (!existing && argv.nodeArg && argv.nodeArg.length) {
      throw new Error(Y()`ERROR: --node-arg/-n can only be used on packages with node scripts.`)
    } else {
      let cmd = existing
      let cmdOpts = argvCmdOpts
      if (existing) {
        cmd = process.argv[0]
        if (process.platform === 'win32') {
          cmd = child.escapeArg(cmd, true)
        }
        // If we know we're running a run script and we got a --node-arg,
        // we need to fudge things a bit to get them working right.
        cmdOpts = argv.nodeArg
        if (cmdOpts) {
          cmdOpts = Array.isArray(cmdOpts) ? cmdOpts : [cmdOpts]
        } else {
          cmdOpts = []
        }
        // It's valid for a single arg to be a string of multiple
        // space-separated node args.
        // Example: `$ npx -n '--inspect --harmony --debug' ...`
        cmdOpts = cmdOpts.reduce((acc, arg) => {
          return acc.concat(arg.split(/\s+/))
        }, [])
        cmdOpts = cmdOpts.concat(existing, argvCmdOpts)
      }
      const opts = Object.assign({}, argv, { cmdOpts })
      return child.runCommand(cmd, opts).catch(err => {
        if (err.isOperational && err.exitCode) {
          // At this point, we want to treat errors from the child as if
          // we were just running the command. That means no extra msg logging
          process.exitCode = err.exitCode
        } else {
          // But if it's not just a regular child-level error, blow up normally
          throw err
        }
      })
    }
  })
}

module.exports._findNodeScript = findNodeScript
function findNodeScript (existing, opts) {
  if (!existing) {
    return Promise.resolve(false)
  } else {
    return promisify(fs.stat)(existing).then(stat => {
      if (opts && opts.isLocal && ['.js', '.cjs'].includes(path.extname(existing))) {
        return existing
      } else if (opts && opts.isLocal && stat.isDirectory()) {
        // npx will execute the directory itself
        try {
          const pkg = require(path.resolve(existing, 'package.json'))
          const target = path.resolve(existing, pkg.bin || pkg.main || 'index.js')
          return findNodeScript(target, opts).then(script => {
            if (script) {
              return script
            } else {
              throw new Error(Y()`command not found: ${target}`)
            }
          })
        } catch (e) {
          throw new Error(Y()`command not found: ${existing}`)
        }
      } else if (process.platform !== 'win32') {
        const bytecount = 400
        const buf = Buffer.alloc(bytecount)
        return promisify(fs.open)(existing, 'r').then(fd => {
          return promisify(fs.read)(fd, buf, 0, bytecount, 0).then(() => {
            return promisify(fs.close)(fd)
          }, err => {
            return promisify(fs.close)(fd).then(() => { throw err })
          })
        }).then(() => {
          const re = /#!\s*(?:\/usr\/bin\/env\s*node|\/usr\/local\/bin\/node|\/usr\/bin\/node)\s*\r?\n/i
          return buf.toString('utf8').match(re) && existing
        })
      } else if (process.platform === 'win32') {
        const buf = Buffer.alloc(1000)
        return promisify(fs.open)(existing, 'r').then(fd => {
          return promisify(fs.read)(fd, buf, 0, 1000, 0).then(() => {
            return promisify(fs.close)(fd)
          }, err => {
            return promisify(fs.close)(fd).then(() => { throw err })
          })
        }).then(() => {
          return buf.toString('utf8').trim()
        }).then(str => {
          const cmd = /"%~dp0\\node\.exe"\s+"%~dp0\\(.*)"\s+%\*/
          const mingw = /"\$basedir\/node"\s+"\$basedir\/(.*)"\s+"\$@"/i
          return str.match(cmd) || str.match(mingw)
        }).then(match => {
          return match && path.join(path.dirname(existing), match[1])
        })
      }
    })
  }
}

function Y () {
  return require('./y.js')
}
