var dnode = require('dnode');
var upnode = require('upnode');
var pushover = require('pushover');
var mkdirp = require('mkdirp');
var spawn = require('child_process').spawn;

var fs = require('fs');
var path = require('path');
var Stream = require('stream').Stream;

module.exports = function (secret) {
    return new Propagit(secret);
};

var logger = function (uid) {
    return function (name, buf) {
        if (name === 'data') {
            var lines = buf.toString().split('\n');
            lines.forEach(function (line) {
                console.log('[' + uid + '] ' + line);
            });
        }
    };
};

function Propagit (opts) {
    if (typeof opts === 'string') {
        opts = { secret : opts };
    }
    
    this.readable = true;
    this.secret = opts.secret;
    this.middleware = [];
    
    var base = opts.basedir || process.cwd();
    this.repodir = path.resolve(opts.repodir || base + '/repos');
    this.deploydir = path.resolve(opts.deploydir || base + '/deploy');
    
    if (opts.hub) this.connect(opts.hub);
}

Propagit.prototype = new Stream;

Propagit.prototype.connect = function (hub) {
    var self = this;
    
    if (typeof hub === 'string') {
        hub = {
            host : hub.split(':')[0],
            port : hub.split(':')[1],
        };
    }
    
    self.hub = upnode.connect(hub, function (remote, conn) {
        remote.auth(self.secret, function (err, res) {
            if (err) self.emit('error', err)
            else {
                self.ports = res.ports;
                self.gitUri = 'http://' + hub.host + ':' + self.ports.git;
                conn.emit('up', res);
            };
        });
    });
    
    [ 'up', 'reconnect', 'down' ].forEach(function (name) {
        self.hub.on(name, self.emit.bind(self, name));
    });
    
    return self;
};

Propagit.prototype.use = function (fn) {
    this.middleware.push(fn);
};

Propagit.prototype.listen = function (controlPort, gitPort) {
    var self = this;
    mkdirp(self.repodir);
    self.drones = [];
    self.ports = {
        control : controlPort,
        git : gitPort,
    };
    
    var server = dnode(function (remote, conn) {
        this.auth = function (secret, cb) {
            if (typeof cb !== 'function') return
            else if (self.secret === secret) {
                cb(null, self.createService(remote, conn));
            }
            else cb('ACCESS DENIED')
        };
    });
    server.use(upnode.ping);
    server.listen(controlPort);
    
    var repos = self.repos = pushover(self.repodir);
    repos.on('push', function (repo) {
        self.emit('push', repo);
        self.drones.forEach(function (drone) {
            drone.fetch(repo, logger(drone.id));
        });
    });
    repos.listen(gitPort);
    
    return self;
};

Propagit.prototype.getDrones = function (opts) {
    var self = this;
    if (!opts) opts = {};
    if (opts.drone === '*') opts.drone = { test : function () { return true } };
    
    var names = opts.drone ? [ opts.drone ] : opts.drones;
    var ids = self.drones.map(function (d) { return d.id });
    
    if (opts.drone && typeof opts.drone.test === 'function') {
        return self.drones.filter(function (d) {
            return opts.drone.test(d.id);
        });
    }
    if (names) {
        return names.map(function (name) {
            var ix = ids.indexOf(name);
            return self.drones[ix];
        }).filter(Boolean);
    }
    else {
        var ix = Math.floor(Math.random() * self.drones.length);
        var drone = self.drones[ix];
        return drone ? [ drone ] : [];
    }
};

Propagit.prototype.createService = function (remote, conn) {
    var self = this;
    
    var service = { ports : self.ports };
    
    service.drones = function (cb) {
        if (typeof cb !== 'function') return;
        cb(self.drones.map(function (d) { return d.id }));
    };
    
    service.ps = function (emit) {
        var drones = self.drones;
        var pending = drones.length;
        if (pending === 0) emit('end')
        
        drones.forEach(function (drone) {
            drone.ps(function (ps) {
                emit('data', drone.id, ps);
                if (--pending === 0) emit('end');
            });
        });
    };
    
    service.deploy = function (opts, cb) {
        if (!opts.drone) opts.drone = '*';
        
        var drones = self.getDrones(opts);
        var pending = drones.length;
        if (pending === 0) return cb()
        
        var errors = [];
        
        drones.forEach(function (drone) {
            self.emit('deploy', drone.id, opts);
            drone.fetch(opts.repo, function (code, sig) {
                if (code) {
                    pending --;
                    var err = new Error(
                        'git fetch exited with error code ' + code
                    );
                    err.command = 'fetch';
                    err.drone = drone.id;
                    err.code = code;
                    err.signal = sig;
                    errors.push(err);
                }
                else drone.deploy(opts, function (code, sig) {
                    pending --;
                    if (code) {
                        var err = new Error(
                            'deploy exited with error code ' + code
                        );
                        err.command = 'deploy';
                        err.drone = drone.id;
                        err.code = code;
                        err.signal = sig;
                        errors.push(err);
                    }
                    if (pending === 0) cb(errors.length && errors);
                })
            });
        });
    };
    
    service.spawn = function (opts, cb) {
        var drones = self.getDrones(opts)
        var pending = drones.length;
        if (pending === 0) return cb()
        
        var ids = [];
        drones.forEach(function (drone) {
            self.emit('spawn', drone.id, opts);
            ids.push(drone.id);
            if (!opts.env) opts.env = {};
            if (!opts.env.DRONE_ID) opts.env.DRONE_ID = drone.id;
            
            drone.spawn(opts, function () {
                if (--pending === 0) cb(null, ids);
            });
        });
    };
    
    service.stop = function (opts, cb) {
        var drones = self.getDrones(opts)
        var pending = drones.length;
        if (pending === 0) return cb()
        
        drones.forEach(function (drone) {
            self.emit('stop', drone.id, opts);
            drone.stop(opts.pid, function () {
                if (--pending === 0) cb(null, drone.id);
            });
        });
    };
    
    service.register = function (role, obj) {
        if (role === 'drone') {
            self.drones.push(obj);
            
            conn.on('end', function () {
                var ix = self.drones.indexOf(obj);
                if (ix >= 0) self.drones.splice(ix, 1);
            });
            
            if (typeof obj.fetch !== 'function') return;
            
            fs.readdir(self.repodir, function (err, repos) {
                if (err) console.error(err)
                else repos.forEach(function (repo) {
                    obj.fetch(repo, logger(obj.id));
                });
            });
        }
    };
    
    self.middleware.forEach(function (m) {
        m(service, conn);
    });
    
    return service;
};

Propagit.prototype.drone = function (fn) {
    var self = this;
    
    mkdirp(self.deploydir);
    mkdirp(self.repodir);
    
    self.processes = {};
    
    function refs (repo) {
        return {
            origin : self.gitUri + '/' + repo,
            repodir : path.join(self.repodir, repo + '.git'),
        }
    }
    self.on('error', self.emit.bind(self, 'error'));
    
    var actions = {};
    
    actions.fetch = function (repo, cb) {
        var p = refs(repo);
        spawn('git', [ 'init', '--bare', p.repodir ])
            .on('exit', function (code, sig) {
                if (code) cb(code, sig)
                else spawn('git', [ 'fetch', p.origin ], { cwd : p.repodir })
                    .on('exit', cb)
                ;
            })
        ;
    };
    
    actions.deploy = function (opts, cb) {
        var repo = opts.repo;
        var commit = opts.commit;
        
        var dir = path.join(self.deploydir, repo + '.' + commit);
        var p = refs(repo);
        
        process.env.COMMIT = commit;
        process.env.REPO = repo;
        
        spawn('git', [ 'clone', p.repodir, dir ])
            .on('exit', function (code, sig) {
                if (code) cb(code, sig)
                else spawn('git', [ 'checkout', commit ], { cwd : dir })
                    .on('exit', function (code, sig) {
                        cb(code, sig)
                    })
                ;
            })
        ;
    };
    
    actions.stop = function (id, cb) {
        if (typeof cb !== 'function') cb = function () {};
        var proc = self.processes[id];
        if (!proc) cb('no such process')
        else {
            proc.status = 'stopped';
            proc.process.kill();
            delete self.processes[id];
            cb();
        }
    };
    
    actions.restart = function (id, cb) {
        if (typeof cb !== 'function') cb = function () {};
        var proc = self.processes[id];
        if (!proc) cb('no such process')
        else {
            if (proc.status === 'stopped') proc.respawn()
            else proc.process.kill()
        }
    };
    
    actions.ps = function (cb) {
        cb(Object.keys(self.processes).reduce(function (acc, id) {
            var proc = self.processes[id];
            acc[id] = {
                status : proc.status,
                repo : proc.repo,
                commit : proc.commit,
                command : proc.command,
            };
            return acc;
        }, {}));
    };
    
    actions.spawn = function (opts, cb) {
        var repo = opts.repo;
        var commit = opts.commit;
        
        process.env.COMMIT = commit;
        process.env.REPO = repo;
        
        var id = Math.floor(Math.random() * (1<<24)).toString(16);
        process.env.PROCESS_ID = id;
        
        Object.keys(opts.env || {}).forEach(function (key) {
            process.env[key] = opts.env[key];
        });
        
        var dir = path.join(self.deploydir, repo + '.' + commit);
        opts.directory = dir;
        
        var cmd = opts.command[0];
        var args = opts.command.slice(1);
        
        var processes = self.processes;
        (function respawn () {
            var ps = spawn(cmd, args, { cwd : dir });
            var proc = self.processes[id] = {
                status : 'running',
                repo : repo,
                commit : commit,
                command : opts.command,
                process : ps,
                respawn : respawn,
            };
            
            ps.stdout.on('data', function (buf) {
                self.emit('stdout', buf, opts);
            });
            
            ps.stderr.on('data', function (buf) {
                self.emit('stderr', buf, opts);
            });
            
            ps.once('exit', function (code, sig) {
                self.emit('exit', code, sig, opts);
                
                if (opts.once) {
                    delete self.processes[id];
                }
                else if (proc.status !== 'stopped') {
                    proc.status = 'respawning';
                    setTimeout(function () {
                        if (proc.status !== 'stopped') respawn();
                    }, 1000);
                }
            });
            
            self.emit('spawn', id, opts);
        })();
        
        cb();
    };
    
    actions.id = (Math.random() * Math.pow(16,8)).toString(16);
    if (typeof fn === 'function') fn.call(self, actions);
    
    self.middleware.forEach(function (m) {
        m(actions);
    });
    
    function onup (remote) {
        remote.register('drone', actions);
    }
    self.hub(onup);
    self.hub.on('down', function () {
        self.hub.once('up', onup);
    });
    
    return self;
};

Propagit.prototype.stop = function (opts, cb) {
    var self = this;
    
    stream.readable = true;
    
    (opts ? self.getDrones(opts) : self.drones).forEach(function (drone) {
        drone.stop(opts.pid, cb);
    });
    
    return self;
};

Propagit.prototype.spawn = function (opts) {
    var self = this;
    
    self.hub(function (hub) {
        hub.spawn(opts, function () {
            self.emit('spawn');
        });
    });
    
    return self;
};

Propagit.prototype.deploy = function (opts, cb) {
    var self = this;
    
    self.hub(function (hub) {
        hub.deploy(opts, function () {
            self.emit('deploy');
            if (cb) cb();
        });
    });
    
    return self;
};

Propagit.prototype.ps = function () {
    var self = this;
    var stream = new Stream;
    self.hub(function (hub) {
        hub.ps(stream.emit.bind(stream));
    });
    return stream;
};
