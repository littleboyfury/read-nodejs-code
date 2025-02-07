// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const EventEmitter = require('events');
const stream = require('stream');
const util = require('util');
const internalUtil = require('internal/util');
const {
  isIP,
  isIPv4,
  isIPv6,
  isLegalPort,
  normalizedArgsSymbol,
  makeSyncWrite
} = require('internal/net');
const assert = require('assert');
const {
  UV_EADDRINUSE,
  UV_EINVAL,
  UV_EOF
} = process.binding('uv');

const { Buffer } = require('buffer');
const TTYWrap = process.binding('tty_wrap');
const { TCP, constants: TCPConstants } = process.binding('tcp_wrap');
const { Pipe, constants: PipeConstants } = process.binding('pipe_wrap');
const { TCPConnectWrap } = process.binding('tcp_wrap');
const { PipeConnectWrap } = process.binding('pipe_wrap');
const { ShutdownWrap, WriteWrap } = process.binding('stream_wrap');
const { async_id_symbol } = process.binding('async_wrap');
const { newUid, defaultTriggerAsyncIdScope } = require('internal/async_hooks');
const { nextTick } = require('internal/process/next_tick');
const errors = require('internal/errors');
const dns = require('dns');

const kLastWriteQueueSize = Symbol('lastWriteQueueSize');

// `cluster` is only used by `listenInCluster` so for startup performance
// reasons it's lazy loaded.
var cluster = null;

const errnoException = util._errnoException;
const exceptionWithHostPort = util._exceptionWithHostPort;

const {
  kTimeout,
  setUnrefTimeout,
  validateTimerDuration,
  refreshFnSymbol
} = require('internal/timers');

function noop() {}

function createHandle(fd, is_server) {
  const type = TTYWrap.guessHandleType(fd);
  if (type === 'PIPE') {
    return new Pipe(
      is_server ? PipeConstants.SERVER : PipeConstants.SOCKET
    );
  }

  if (type === 'TCP') {
    return new TCP(
      is_server ? TCPConstants.SERVER : TCPConstants.SOCKET
    );
  }

  throw new errors.TypeError('ERR_INVALID_FD_TYPE', type);
}


function getNewAsyncId(handle) {
  return (!handle || typeof handle.getAsyncId !== 'function') ?
    newUid() : handle.getAsyncId();
}


const debug = util.debuglog('net');

function isPipeName(s) {
  return typeof s === 'string' && toNumber(s) === false;
}

function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}


// Target API:
//
// var s = net.connect({port: 80, host: 'google.com'}, function() {
//   ...
// });
//
// There are various forms:
//
// connect(options, [cb])
// connect(port, [host], [cb])
// connect(path, [cb]);
//
function connect(...args) {
  var normalized = normalizeArgs(args);
  var options = normalized[0];
  debug('createConnection', normalized);
  var socket = new Socket(options);
  // 设置超时，超时后会触发timeout，需要用户手动关闭socket
  if (options.timeout) {
    socket.setTimeout(options.timeout);
  }

  return Socket.prototype.connect.call(socket, normalized);
}


// Returns an array [options, cb], where options is an object,
// cb is either a function or null.
// Used to normalize arguments of Socket.prototype.connect() and
// Server.prototype.listen(). Possible combinations of parameters:
//   (options[...][, cb])
//   (path[...][, cb])
//   ([port][, host][...][, cb])
// For Socket.prototype.connect(), the [...] part is ignored
// For Server.prototype.listen(), the [...] part is [, backlog]
// but will not be handled here (handled in listen())
function normalizeArgs(args) {
  var arr;

  if (args.length === 0) {
    arr = [{}, null];
    arr[normalizedArgsSymbol] = true;
    return arr;
  }

  const arg0 = args[0];
  var options = {};
  if (typeof arg0 === 'object' && arg0 !== null) {
    // (options[...][, cb])
    options = arg0;
  } else if (isPipeName(arg0)) {
    // (path[...][, cb])
    options.path = arg0;
  } else {
    // ([port][, host][...][, cb])
    options.port = arg0;
    if (args.length > 1 && typeof args[1] === 'string') {
      options.host = args[1];
    }
  }

  var cb = args[args.length - 1];
  if (typeof cb !== 'function')
    arr = [options, null];
  else
    arr = [options, cb];

  arr[normalizedArgsSymbol] = true;
  return arr;
}


// called when creating new Socket, or when re-using a closed Socket
function initSocketHandle(self) {
  // 恢复可读流和可写流的状态和标记 
  self._undestroy();
  self._bytesDispatched = 0;
  self._sockname = null;

  // Handle creation may be deferred to bind() or connect() time.
  if (self._handle) {
    self._handle.owner = self;
    self._handle.onread = onread;
    self[async_id_symbol] = getNewAsyncId(self._handle);

    // If handle doesn't support writev - neither do we
    if (!self._handle.writev)
      self._writev = null;
  }
}


const BYTES_READ = Symbol('bytesRead');


function Socket(options) {
  if (!(this instanceof Socket)) return new Socket(options);
  // 是否正在连接
  this.connecting = false;
  // Problem with this is that users can supply their own handle, that may not
  // have _handle.getAsyncId(). In this case an[async_id_symbol] should
  // probably be supplied by async_hooks.
  this[async_id_symbol] = -1;
  // close的时候是否是因为error导致的
  this._hadError = false;
  this._handle = null;
  this._parent = null;
  this._host = null;
  this[kLastWriteQueueSize] = 0;
  this[kTimeout] = null;

  if (typeof options === 'number')
    options = { fd: options }; // Legacy interface.
  else if (options === undefined)
    options = {};

  stream.Duplex.call(this, options);
  // 在socket中关联这次连接的一个实体，handle代表客户端的handle
  if (options.handle) {
    this._handle = options.handle; // private
    this[async_id_symbol] = getNewAsyncId(this._handle);
  } else if (options.fd !== undefined) {
    const fd = options.fd;
    // 创建一个对象，并且关联到fd
    this._handle = createHandle(fd, false);
    this._handle.open(fd);
    this[async_id_symbol] = this._handle.getAsyncId();
    // options.fd can be string (since it is user-defined),
    // so changing this to === would be semver-major
    // See: https://github.com/nodejs/node/pull/11513
    // eslint-disable-next-line eqeqeq
    if ((fd == 1 || fd == 2) &&
        (this._handle instanceof Pipe) &&
        process.platform === 'win32') {
      // Make stdout and stderr blocking on Windows
      var err = this._handle.setBlocking(true);
      if (err)
        throw errnoException(err, 'setBlocking');

      this._writev = null;
      this._write = makeSyncWrite(fd);
    }
    this.readable = options.readable !== false;
    this.writable = options.writable !== false;
  } else {
    // these will be set once there is a connection
    // 先初始化为false，连接成功后再重新设置
    this.readable = this.writable = false;
  }

  // shut down the socket when we're finished with it.
  // 可写流关闭并且数据发送完毕时触发finish事件
  this.on('finish', onSocketFinish);
  // 读结束触发_socketEnd
  this.on('_socketEnd', onSocketEnd);

  initSocketHandle(this);

  this._pendingData = null;
  this._pendingEncoding = '';

  // handle strings directly
  // 数据不需要解码处理
  this._writableState.decodeStrings = false;

  // default to *not* allowing half open sockets
  // 是否允许半开关，默认是不允许
  this.allowHalfOpen = options && options.allowHalfOpen || false;

  // if we have a handle, then start the flow of data into the
  // buffer.  if not, then this will happen when we connect
  // 可读
  if (this._handle && options.readable !== false) {
    // pauseOnCreate标记在创建socket的时候是否开始流式读，false则停止触发读 
    if (options.pauseOnCreate) {
      // stop the handle from reading and pause the stream
      this._handle.reading = false;
      this._handle.readStop();
      this.readableFlowing = false;
    } else if (!options.manualStart) {// 是否设置了手动开启读
      // 触发底层注册一些函数，开启流式读
      this.read(0);
    }
  }

  // Reserve properties
  this.server = null;
  this._server = null;

  // Used after `.destroy()`
  this[BYTES_READ] = 0;
}
util.inherits(Socket, stream.Duplex);

// Refresh existing timeouts.
// 重置超时时间
Socket.prototype._unrefTimer = function _unrefTimer() {
  for (var s = this; s !== null; s = s._parent) {
    if (s[kTimeout])
      s[kTimeout][refreshFnSymbol]();
  }
};

// 发送关闭写端的请求
function shutdownSocket(self, callback) {
  var req = new ShutdownWrap();
  req.oncomplete = callback;
  req.handle = self._handle;
  return self._handle.shutdown(req);
}

// the user has called .end(), and all the bytes have been
// sent out to the other side.
// 执行了end，并且数据发送完毕，则关闭写端
function onSocketFinish() {
  // If still connecting - defer handling 'finish' until 'connect' will happen
  // 还没连接成功就执行了end
  if (this.connecting) {
    debug('osF: not yet connected');
    return this.once('connect', onSocketFinish);
  }

  debug('onSocketFinish');
  // 写结束了，如果也不能读或者读结束了，则销毁socket
  if (!this.readable || this._readableState.ended) {
    debug('oSF: ended, destroy', this._readableState);
    return this.destroy();
  }

  debug('oSF: not ended, call shutdown()');

  // otherwise, just shutdown, or destroy() if not possible
  // 不支持shutdown则直接销毁
  if (!this._handle || !this._handle.shutdown)
    return this.destroy();
  // 支持shutdown则执行关闭，并设置回调
  var err = defaultTriggerAsyncIdScope(
    this[async_id_symbol], shutdownSocket, this, afterShutdown
  );
  // 执行shutdown失败则直接销毁
  if (err)
    return this.destroy(errnoException(err, 'shutdown'));
}

// 关闭写端成功后的回调
function afterShutdown(status, handle, req) {
  // handle关联的socket
  var self = handle.owner;

  debug('afterShutdown destroyed=%j', self.destroyed,
        self._readableState);

  // callback may come after call to destroy.
  // 已经销毁了，则不需要往下走了，否则执行销毁操作
  if (self.destroyed)
    return;
  // 写关闭成功，并且读也结束了，则销毁socket，否则等待读结束再执行销毁
  if (self._readableState.ended) {
    debug('readableState ended, destroying');
    self.destroy();
  } else {
    self.once('_socketEnd', self.destroy);
  }
}

// the EOF has been received, and no more bytes are coming.
// if the writable side has ended already, then clean everything
// up.
// 读结束后执行的函数
function onSocketEnd() {
  // XXX Should not have to do as much in this function.
  // ended should already be true, since this is called *after*
  // the EOF errno and onread has eof'ed
  debug('onSocketEnd', this._readableState);
  // 读结束标记
  this._readableState.ended = true;
  // 已经触发了end事件，则判断是否需要销毁，见maybeDestroy
  if (this._readableState.endEmitted) {
    this.readable = false;
    maybeDestroy(this);
  } else {
    // 还没有触发end则等待触发end事件再执行下一步操作
    this.once('end', function end() {
      this.readable = false;
      maybeDestroy(this);
    });
    // 执行read，如果流中没有缓存的数据则会触发end事件，否则等待消费完后再触发
    this.read(0);
  }
  // 读结束后，如果不允许半开关，则关闭写端，并重置写函数，后续执行写的时候报错
  if (!this.allowHalfOpen) {
    this.write = writeAfterFIN;
    this.destroySoon();
  }
}

// Provide a better error message when we call end() as a result
// of the other side sending a FIN.  The standard 'write after end'
// is overly vague, and makes it seem like the user's code is to blame.
function writeAfterFIN(chunk, encoding, cb) {
  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }
  // 对端已经断开，不能写了
  var er = new Error('This socket has been ended by the other party');
  er.code = 'EPIPE';
  // TODO: defer error events consistently everywhere, not just the cb
  this.emit('error', er);
  if (typeof cb === 'function') {
    nextTick(this[async_id_symbol], cb, er);
  }
}

Socket.prototype.read = function(n) {
  // 0表示开启读
  if (n === 0)
    return stream.Readable.prototype.read.call(this, n);

  this.read = stream.Readable.prototype.read;
  // 标记正在消费数据，用于应用层
  this._consuming = true;
  return this.read(n);
};
// 设置socket的超时时间，多次调用会注册多个回调，但是只有一个超时时间
Socket.prototype.setTimeout = function(msecs, callback) {
  // Type checking identical to timers.enroll()
  msecs = validateTimerDuration(msecs);

  // Attempt to clear an existing timer lear in both cases -
  //  even if it will be rescheduled we don't want to leak an existing timer.
  // 清除之前的定时器
  clearTimeout(this[kTimeout]);
  // 等于0说明想清除之前的设置的值
  if (msecs === 0) {
    if (callback) {
      this.removeListener('timeout', callback);
    }
  } else {
    // 设置unref的定时器，不影响事件循环退出
    this[kTimeout] = setUnrefTimeout(this._onTimeout.bind(this), msecs);
    // 注册超时事件，超时后回调
    if (callback) {
      this.once('timeout', callback);
    }
  }
  return this;
};

// socket超时的处理函数
Socket.prototype._onTimeout = function() {
  const handle = this._handle;
  const lastWriteQueueSize = this[kLastWriteQueueSize];
  if (lastWriteQueueSize > 0 && handle) {
    // `lastWriteQueueSize !== writeQueueSize` means there is
    // an active write in progress, so we suppress the timeout.
    const writeQueueSize = handle.writeQueueSize;
    if (lastWriteQueueSize !== writeQueueSize) {
      this[kLastWriteQueueSize] = writeQueueSize;
      this._unrefTimer();
      return;
    }
  }
  debug('_onTimeout');
  this.emit('timeout');
};


Socket.prototype.setNoDelay = function(enable) {
  if (!this._handle) {
    this.once('connect',
              enable ? this.setNoDelay : () => this.setNoDelay(enable));
    return this;
  }

  // backwards compatibility: assume true when `enable` is omitted
  if (this._handle.setNoDelay)
    this._handle.setNoDelay(enable === undefined ? true : !!enable);

  return this;
};


Socket.prototype.setKeepAlive = function(setting, msecs) {
  if (!this._handle) {
    this.once('connect', () => this.setKeepAlive(setting, msecs));
    return this;
  }

  if (this._handle.setKeepAlive)
    this._handle.setKeepAlive(setting, ~~(msecs / 1000));

  return this;
};


Socket.prototype.address = function() {
  return this._getsockname();
};


Object.defineProperty(Socket.prototype, '_connecting', {
  get: function() {
    return this.connecting;
  }
});


Object.defineProperty(Socket.prototype, 'readyState', {
  get: function() {
    if (this.connecting) {
      return 'opening';
    } else if (this.readable && this.writable) {
      return 'open';
    } else if (this.readable && !this.writable) {
      return 'readOnly';
    } else if (!this.readable && this.writable) {
      return 'writeOnly';
    } else {
      return 'closed';
    }
  }
});

// 待写入的数据总长度（编码前）
Object.defineProperty(Socket.prototype, 'bufferSize', {
  get: function() {
    if (this._handle) {
      return this[kLastWriteQueueSize] + this.writableLength;
    }
  }
});


// Just call handle.readStart until we have enough in the buffer
// 实现读的核心逻辑
Socket.prototype._read = function(n) {
  debug('_read');
  // 还没有连接成功，则等待
  if (this.connecting || !this._handle) {
    debug('_read wait for connection');
    this.once('connect', () => this._read(n));
  } else if (!this._handle.reading) {
    // not already reading, start the flow
    debug('Socket._read readStart');
    // 开启读
    this._handle.reading = true;
    var err = this._handle.readStart();
    if (err)
      this.destroy(errnoException(err, 'read'));
  }
};

// 关闭流写端
Socket.prototype.end = function(data, encoding) {
  // 关闭写端
  stream.Duplex.prototype.end.call(this, data, encoding);
  this.writable = false;
  DTRACE_NET_STREAM_END(this);
  LTTNG_NET_STREAM_END(this);

  // just in case we're waiting for an EOF.
  if (this.readable && !this._readableState.endEmitted)
    this.read(0);
  else
    maybeDestroy(this);

  return this;
};


// Call whenever we set writable=false or readable=false
// 一端结束，判断是否需要销毁socket，比如不允许半开关
function maybeDestroy(socket) {
  if (!socket.readable &&
      !socket.writable &&
      !socket.destroyed &&
      !socket.connecting &&
      !socket.writableLength) {
    socket.destroy();
  }
}

// 关闭读端，不允许半开关，同时关闭写端 
Socket.prototype.destroySoon = function() {
  // 还可写则执行关闭
  if (this.writable)
    this.end();
  // 写端已经结束，则销毁socekt，否则等待写端结束再销毁
  if (this._writableState.finished)
    this.destroy();
  else
    this.once('finish', this.destroy);
};

// 销毁时执行的钩子函数，exception代表是否因为错误导致的销毁
Socket.prototype._destroy = function(exception, cb) {
  debug('destroy');

  this.connecting = false;

  this.readable = this.writable = false;

  for (var s = this; s !== null; s = s._parent) {
    clearTimeout(s[kTimeout]);
  }

  debug('close');
  if (this._handle) {
    if (this !== process.stderr)
      debug('close handle');
    var isException = exception ? true : false;
    // `bytesRead` should be accessible after `.destroy()`
    this[BYTES_READ] = this._handle.bytesRead;
    // 关闭底层handle
    this._handle.close(() => {
      debug('emit close');
      // close事件的入参，表示是否因为错误导致的关闭
      this.emit('close', isException);
    });
    this._handle.onread = noop;
    this._handle = null;
    this._sockname = null;
  }
  // 执行回调
  cb(exception);
  // socket所属的server
  if (this._server) {
    COUNTER_NET_SERVER_CONNECTION_CLOSE(this);
    debug('has server');
    // server下的连接数减一
    this._server._connections--;
    // 是否需要触发server的close事件，当所有的连接（socket）都关闭时才触发server的是close事件
    if (this._server._emitCloseIfDrained) {
      this._server._emitCloseIfDrained();
    }
  }
};


// This function is called whenever the handle gets a
// buffer, or when there's an error reading.
// 有数据时执行的回调
function onread(nread, buffer) {
  var handle = this;
  // handle关联的socket
  var self = handle.owner;
  assert(handle === self._handle, 'handle != self._handle');
  // 重置定时器 
  self._unrefTimer();

  debug('onread', nread);
  // 读成功
  if (nread > 0) {
    debug('got data');

    // read success.
    // In theory (and in practice) calling readStop right now
    // will prevent this from being called again until _read() gets
    // called again.

    // Optimization: emit the original buffer with end points
    // 保存到可读流，返回是否还可以读取更多数据
    var ret = self.push(buffer);
    // 正在读并且不能读取更多数据了，则注销等待可读事件
    if (handle.reading && !ret) {
      handle.reading = false;
      debug('readStop');
      var err = handle.readStop();
      if (err)
        self.destroy(errnoException(err, 'read'));
    }
    return;
  }

  // if we didn't get any bytes, that doesn't necessarily mean EOF.
  // wait for the next one.
  // 没有数据，忽略
  if (nread === 0) {
    debug('not any data, keep waiting');
    return;
  }

  // Error, possibly EOF.
  // 小于0并且不等于读结束，说明读出错，销毁socket，并报错
  if (nread !== UV_EOF) {
    return self.destroy(errnoException(nread, 'read'));
  }

  debug('EOF');

  // push a null to signal the end of data.
  // Do it before `maybeDestroy` for correct order of events:
  // `end` -> `close`
  // 读结束，告诉可读流
  self.push(null);
  // 当前待读取的数据长度是0，则判断是否可以销毁socket
  if (self.readableLength === 0) {
    self.readable = false;
    maybeDestroy(self);
  }

  // internal end event so that we know that the actual socket
  // is no longer readable, and we can start the shutdown
  // procedure. No need to wait for all the data to be consumed.
  // 触发读结束事件 
  self.emit('_socketEnd');
}

// 获取对端地址信息并缓存下来
Socket.prototype._getpeername = function() {
  if (!this._peername) {
    if (!this._handle || !this._handle.getpeername) {
      return {};
    }
    var out = {};
    var err = this._handle.getpeername(out);
    if (err) return {};  // FIXME(bnoordhuis) Throw?
    this._peername = out;
  }
  return this._peername;
};

function protoGetter(name, callback) {
  Object.defineProperty(Socket.prototype, name, {
    configurable: false,
    enumerable: true,
    get: callback
  });
}

protoGetter('bytesRead', function bytesRead() {
  return this._handle ? this._handle.bytesRead : this[BYTES_READ];
});

protoGetter('remoteAddress', function remoteAddress() {
  return this._getpeername().address;
});

protoGetter('remoteFamily', function remoteFamily() {
  return this._getpeername().family;
});

protoGetter('remotePort', function remotePort() {
  return this._getpeername().port;
});

// 获取本端地址信息并缓存
Socket.prototype._getsockname = function() {
  if (!this._handle || !this._handle.getsockname) {
    return {};
  }
  if (!this._sockname) {
    var out = {};
    var err = this._handle.getsockname(out);
    if (err) return {};  // FIXME(bnoordhuis) Throw?
    this._sockname = out;
  }
  return this._sockname;
};


protoGetter('localAddress', function localAddress() {
  return this._getsockname().address;
});


protoGetter('localPort', function localPort() {
  return this._getsockname().port;
});


Socket.prototype._writeGeneric = function(writev, data, encoding, cb) {
  // If we are still connecting, then buffer this for later.
  // The Writable logic will buffer up any more writes while
  // waiting for this one to be done.
  // 正在连接，则先保存待写的数据
  if (this.connecting) {
    this._pendingData = data;
    this._pendingEncoding = encoding;
    this.once('connect', function connect() {
      this._writeGeneric(writev, data, encoding, cb);
    });
    return;
  }
  // 开始写，则恢复之前缓存的数据
  this._pendingData = null;
  this._pendingEncoding = '';
  // 写操作，有数据通信，刷新定时器
  this._unrefTimer();

  if (!this._handle) {
    this.destroy(new errors.Error('ERR_SOCKET_CLOSED'), cb);
    return false;
  }
  // 新建一个写请求
  var req = new WriteWrap();
  req.handle = this._handle;
  req.oncomplete = afterWrite;
  req.async = false;
  var err;
  // 是否批量写
  if (writev) {
    // 所有数据都是buffer类型，则直接堆起来，否则需要保存编码类型
    var allBuffers = data.allBuffers;
    var chunks;
    var i;
    if (allBuffers) {
      chunks = data;
      for (i = 0; i < data.length; i++)
        data[i] = data[i].chunk;
    } else {
      // 申请double个大小的数组
      chunks = new Array(data.length << 1);
      for (i = 0; i < data.length; i++) {
        var entry = data[i];
        chunks[i * 2] = entry.chunk;
        chunks[i * 2 + 1] = entry.encoding;
      }
    }
    err = this._handle.writev(req, chunks, allBuffers);

    // Retain chunks
    if (err === 0) req._chunks = chunks;
  } else {
    var enc;
    if (data instanceof Buffer) {
      enc = 'buffer';
    } else {
      enc = encoding;
    }
    err = createWriteReq(req, this._handle, data, enc);
  }

  if (err)
    return this.destroy(errnoException(err, 'write', req.error), cb);
  // 请求写入底层的数据字节长度
  this._bytesDispatched += req.bytes;

  if (!req.async) {
    cb();
    return;
  }

  req.cb = cb;
  // 最后一次请求写数据的字节长度
  this[kLastWriteQueueSize] = req.bytes;
};

// 批量写
Socket.prototype._writev = function(chunks, cb) {
  this._writeGeneric(true, chunks, '', cb);
};

// 单个写
Socket.prototype._write = function(data, encoding, cb) {
  this._writeGeneric(false, data, encoding, cb);
};

function createWriteReq(req, handle, data, encoding) {
  switch (encoding) {
    case 'latin1':
    case 'binary':
      return handle.writeLatin1String(req, data);

    case 'buffer':
      return handle.writeBuffer(req, data);

    case 'utf8':
    case 'utf-8':
      return handle.writeUtf8String(req, data);

    case 'ascii':
      return handle.writeAsciiString(req, data);

    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return handle.writeUcs2String(req, data);

    default:
      return handle.writeBuffer(req, Buffer.from(data, encoding));
  }
}

// 写数据的字节数
protoGetter('bytesWritten', function bytesWritten() {
  // 已经向底层发出写请求的字节数
  var bytes = this._bytesDispatched;
  const state = this._writableState;
  const data = this._pendingData;
  const encoding = this._pendingEncoding;

  if (!state)
    return undefined;
  // 在可写流中缓存的字节数
  this.writableBuffer.forEach(function(el) {
    if (el.chunk instanceof Buffer)
      bytes += el.chunk.length;
    else
      bytes += Buffer.byteLength(el.chunk, el.encoding);
  });
  // 因为未连接成功而缓存的数据字节数，这个状态中，数据只会存着可写流的缓存和pendData，_bytesDispatched为0 
  if (Array.isArray(data)) {
    // was a writev, iterate over chunks to get total length
    for (var i = 0; i < data.length; i++) {
      const chunk = data[i];

      if (data.allBuffers || chunk instanceof Buffer)
        bytes += chunk.length;
      else
        bytes += Buffer.byteLength(chunk.chunk, chunk.encoding);
    }
  } else if (data) {
    // Writes are either a string or a Buffer.
    if (typeof data !== 'string')
      bytes += data.length;
    else
      bytes += Buffer.byteLength(data, encoding);
  }

  return bytes;
});

// 写完成的回调，成功或失败
function afterWrite(status, handle, req, err) {
  // handle关联的socket
  var self = handle.owner;
  if (self !== process.stderr && self !== process.stdout)
    debug('afterWrite', status);

  if (req.async)
    self[kLastWriteQueueSize] = 0;

  // callback may come after call to destroy.
  // 执行写的时候或执行回调之前，socket被销毁了
  if (self.destroyed) {
    debug('afterWrite destroyed');
    return;
  }
  // 写失败，则销毁socket
  if (status < 0) {
    var ex = errnoException(status, 'write', req.error);
    debug('write failure', ex);
    self.destroy(ex, req.cb);
    return;
  }
  // 
  self._unrefTimer();

  if (self !== process.stderr && self !== process.stdout)
    debug('afterWrite call cb');

  if (req.cb)
    req.cb.call(undefined);
}


function checkBindError(err, port, handle) {
  // EADDRINUSE may not be reported until we call listen() or connect().
  // To complicate matters, a failed bind() followed by listen() or connect()
  // will implicitly bind to a random port. Ergo, check that the socket is
  // bound to the expected port before calling listen() or connect().
  //
  // FIXME(bnoordhuis) Doesn't work for pipe handles, they don't have a
  // getsockname() method. Non-issue for now, the cluster module doesn't
  // really support pipes anyway.
  if (err === 0 && port > 0 && handle.getsockname) {
    var out = {};
    err = handle.getsockname(out);
    if (err === 0 && port !== out.port) {
      debug(`checkBindError, bound to ${out.port} instead of ${port}`);
      err = UV_EADDRINUSE;
    }
  }
  return err;
}

// 发起连接 
function internalConnect(
  self, address, port, addressType, localAddress, localPort) {
  // TODO return promise from Socket.prototype.connect which
  // wraps _connectReq.

  assert(self.connecting);

  var err;
  // 设置了本地地址，则绑定，否则操作系统随机选择
  if (localAddress || localPort) {
    if (addressType === 4) {
      localAddress = localAddress || '0.0.0.0';
      err = self._handle.bind(localAddress, localPort);
    } else if (addressType === 6) {
      localAddress = localAddress || '::';
      err = self._handle.bind6(localAddress, localPort);
    } else {
      self.destroy(new TypeError('Invalid addressType: ' + addressType));
      return;
    }
    debug('binding to localAddress: %s and localPort: %d (addressType: %d)',
          localAddress, localPort, addressType);

    err = checkBindError(err, localPort, self._handle);
    if (err) {
      const ex = exceptionWithHostPort(err, 'bind', localAddress, localPort);
      self.destroy(ex);
      return;
    }
  }
  // tcp或unix域、命名管道
  if (addressType === 6 || addressType === 4) {
    // 新建一个连接请求
    const req = new TCPConnectWrap();
    req.oncomplete = afterConnect;
    req.address = address;
    req.port = port;
    req.localAddress = localAddress;
    req.localPort = localPort;
    // 非阻塞发起连接
    if (addressType === 4)
      err = self._handle.connect(req, address, port);
    else
      err = self._handle.connect6(req, address, port);
  } else {
    // unix域或命名管道
    const req = new PipeConnectWrap();
    req.address = address;
    req.oncomplete = afterConnect;

    err = self._handle.connect(req, address, afterConnect);
  }
  // 连接出错销毁socket
  if (err) {
    var sockname = self._getsockname();
    var details;

    if (sockname) {
      details = sockname.address + ':' + sockname.port;
    }

    const ex = exceptionWithHostPort(err, 'connect', address, port, details);
    self.destroy(ex);
  }
}


Socket.prototype.connect = function(...args) {
  let normalized;
  // If passed an array, it's treated as an array of arguments that have
  // already been normalized (so we don't normalize more than once). This has
  // been solved before in https://github.com/nodejs/node/pull/12342, but was
  // reverted as it had unintended side effects.
  if (Array.isArray(args[0]) && args[0][normalizedArgsSymbol]) {
    normalized = args[0];
  } else {
    normalized = normalizeArgs(args);
  }
  var options = normalized[0];
  var cb = normalized[1];

  if (this.write !== Socket.prototype.write)
    this.write = Socket.prototype.write;

  if (this.destroyed) {
    this._undestroy();
    this._handle = null;
    this._peername = null;
    this._sockname = null;
  }

  const path = options.path;
  var pipe = !!path;
  debug('pipe', pipe, path);

  if (!this._handle) {
    this._handle = pipe ?
      new Pipe(PipeConstants.SOCKET) :
      new TCP(TCPConstants.SOCKET);
    initSocketHandle(this);
  }
  // 传了回调则连接成功时触发
  if (cb !== null) {
    this.once('connect', cb);
  }
  // 重置定时器
  this._unrefTimer();
  // 连接中
  this.connecting = true;
  // 
  this.writable = true;

  if (pipe) {
    if (typeof path !== 'string') {
      throw new errors.TypeError('ERR_INVALID_ARG_TYPE',
                                 'options.path',
                                 'string',
                                 path);
    }
    defaultTriggerAsyncIdScope(
      this[async_id_symbol], internalConnect, this, path
    );
  } else {
    lookupAndConnect(this, options);
  }
  return this;
};


function lookupAndConnect(self, options) {
  var host = options.host || 'localhost';
  var port = options.port;
  var localAddress = options.localAddress;
  var localPort = options.localPort;

  if (localAddress && !isIP(localAddress)) {
    throw new errors.TypeError('ERR_INVALID_IP_ADDRESS', localAddress);
  }

  if (localPort && typeof localPort !== 'number') {
    throw new errors.TypeError('ERR_INVALID_ARG_TYPE',
                               'options.localPort',
                               'number',
                               localPort);
  }

  if (typeof port !== 'undefined') {
    if (typeof port !== 'number' && typeof port !== 'string') {
      throw new errors.TypeError('ERR_INVALID_ARG_TYPE',
                                 'options.port',
                                 ['number', 'string'],
                                 port);
    }
    if (!isLegalPort(port)) {
      throw new errors.RangeError('ERR_SOCKET_BAD_PORT', port);
    }
  }
  port |= 0;

  // If host is an IP, skip performing a lookup
  var addressType = isIP(host);
  if (addressType) {
    nextTick(self[async_id_symbol], function() {
      if (self.connecting)
        defaultTriggerAsyncIdScope(
          self[async_id_symbol],
          internalConnect,
          self, host, port, addressType, localAddress, localPort
        );
    });
    return;
  }

  if (options.lookup && typeof options.lookup !== 'function')
    throw new errors.TypeError('ERR_INVALID_ARG_TYPE',
                               'options.lookup',
                               'Function',
                               options.lookup);

  var dnsopts = {
    family: options.family,
    hints: options.hints || 0
  };

  if (process.platform !== 'win32' &&
      dnsopts.family !== 4 &&
      dnsopts.family !== 6 &&
      dnsopts.hints === 0) {
    dnsopts.hints = dns.ADDRCONFIG;
  }

  debug('connect: find host', host);
  debug('connect: dns options', dnsopts);
  self._host = host;
  var lookup = options.lookup || dns.lookup;
  defaultTriggerAsyncIdScope(self[async_id_symbol], function() {
    lookup(host, dnsopts, function emitLookup(err, ip, addressType) {
      self.emit('lookup', err, ip, addressType, host);

      // It's possible we were destroyed while looking this up.
      // XXX it would be great if we could cancel the promise returned by
      // the look up.
      if (!self.connecting) return;

      if (err) {
        // net.createConnection() creates a net.Socket object and
        // immediately calls net.Socket.connect() on it (that's us).
        // There are no event listeners registered yet so defer the
        // error event to the next tick.
        err.host = options.host;
        err.port = options.port;
        err.message = err.message + ' ' + options.host + ':' + options.port;
        process.nextTick(connectErrorNT, self, err);
      } else {
        self._unrefTimer();
        defaultTriggerAsyncIdScope(
          self[async_id_symbol],
          internalConnect,
          self, ip, port, addressType, localAddress, localPort
        );
      }
    });
  });
}


function connectErrorNT(self, err) {
  self.destroy(err);
}

// 修改socket底层的handle状态，影响事件循环退出
Socket.prototype.ref = function() {
  if (!this._handle) {
    this.once('connect', this.ref);
    return this;
  }

  if (typeof this._handle.ref === 'function') {
    this._handle.ref();
  }

  return this;
};

// 同上，socket不会影响底层事件循环的退出
Socket.prototype.unref = function() {
  if (!this._handle) {
    this.once('connect', this.unref);
    return this;
  }

  if (typeof this._handle.unref === 'function') {
    this._handle.unref();
  }

  return this;
};

// 连接后执行的回调，成功或失败
function afterConnect(status, handle, req, readable, writable) {
  // handle连接的socket
  var self = handle.owner;

  // callback may come after call to destroy
  if (self.destroyed) {
    return;
  }

  // Update handle if it was wrapped
  // TODO(indutny): assert that the handle is actually an ancestor of old one
  handle = self._handle;

  debug('afterConnect');

  assert(self.connecting);
  self.connecting = false;
  self._sockname = null;
  // 连接成功
  if (status === 0) {
    // 设置读写属性
    self.readable = readable;
    self.writable = writable;
    self._unrefTimer();
    // 触发连接成功事件
    self.emit('connect');

    // start the first read, or get an immediate EOF.
    // this doesn't actually consume any bytes, because len=0.
    // 可读并且没有设置暂停模式，则开启读
    if (readable && !self.isPaused())
      self.read(0);

  } else {
    // 连接失败，报错并销毁socket
    self.connecting = false;
    var details;
    if (req.localAddress && req.localPort) {
      details = req.localAddress + ':' + req.localPort;
    }
    var ex = exceptionWithHostPort(status,
                                   'connect',
                                   req.address,
                                   req.port,
                                   details);
    if (details) {
      ex.localAddress = req.localAddress;
      ex.localPort = req.localPort;
    }
    self.destroy(ex);
  }
}


function Server(options, connectionListener) {
  if (!(this instanceof Server))
    return new Server(options, connectionListener);

  EventEmitter.call(this);
  // connectionListener在http.js处理过了
  if (typeof options === 'function') {
    connectionListener = options;
    options = {};
    this.on('connection', connectionListener);
  } else if (options == null || typeof options === 'object') {
    options = options || {};

    if (typeof connectionListener === 'function') {
      this.on('connection', connectionListener);
    }
  } else {
    throw new errors.TypeError('ERR_INVALID_ARG_TYPE',
                               'options',
                               'Object',
                               options);
  }

  this._connections = 0;

  Object.defineProperty(this, 'connections', {
    get: internalUtil.deprecate(() => {

      if (this._usingWorkers) {
        return null;
      }
      return this._connections;
    }, 'Server.connections property is deprecated. ' +
       'Use Server.getConnections method instead.', 'DEP0020'),
    set: internalUtil.deprecate((val) => (this._connections = val),
                                'Server.connections property is deprecated.',
                                'DEP0020'),
    configurable: true, enumerable: false
  });

  this[async_id_symbol] = -1;
  this._handle = null;
  this._usingWorkers = false;
  this._workers = [];
  this._unref = false;

  this.allowHalfOpen = options.allowHalfOpen || false;
  this.pauseOnConnect = !!options.pauseOnConnect;
}
util.inherits(Server, EventEmitter);


function toNumber(x) { return (x = Number(x)) >= 0 ? x : false; }

// Returns handle if it can be created, or error code if it can't
// 创建一个座位server的handle
function createServerHandle(address, port, addressType, fd) {
  var err = 0;
  // assign handle in listen, and clean up if bind or listen fails
  var handle;

  var isTCP = false;
  // 传了fd，则根据fd类型创建一个handle并把fd关联到handle中
  if (typeof fd === 'number' && fd >= 0) {
    try {
      handle = createHandle(fd, true);
    } catch (e) {
      // Not a fd we can listen on.  This will trigger an error.
      debug('listen invalid fd=%d:', fd, e.message);
      return UV_EINVAL;
    }
    handle.open(fd);
    handle.readable = true;
    handle.writable = true;
    assert(!address && !port);
    // 管道
  } else if (port === -1 && addressType === -1) {
    // unix域、命名管道server
    handle = new Pipe(PipeConstants.SERVER);
    if (process.platform === 'win32') {
      var instances = parseInt(process.env.NODE_PENDING_PIPE_INSTANCES);
      if (!isNaN(instances)) {
        handle.setPendingInstances(instances);
      }
    }
  } else {
    // tcp server
    handle = new TCP(TCPConstants.SERVER);
    isTCP = true;
  }
  // 需要绑定地址则执行bind
  if (address || port || isTCP) {
    debug('bind to', address || 'any');
    if (!address) {
      // Try binding to ipv6 first
      err = handle.bind6('::', port);
      if (err) {
        handle.close();
        // Fallback to ipv4
        return createServerHandle('0.0.0.0', port);
      }
    } else if (addressType === 6) {
      err = handle.bind6(address, port);
    } else {
      err = handle.bind(address, port);
    }
  }

  if (err) {
    handle.close();
    return err;
  }

  return handle;
}
// 设置handle为listen状态
function setupListenHandle(address, port, addressType, backlog, fd) {
  debug('setupListenHandle', address, port, addressType, backlog, fd);

  // If there is not yet a handle, we need to create one and bind.
  // In the case of a server sent via IPC, we don't need to do this.
  if (this._handle) {
    debug('setupListenHandle: have a handle already');
  } else {
    debug('setupListenHandle: create a handle');

    var rval = null;

    // Try to bind to the unspecified IPv6 address, see if IPv6 is available
    if (!address && typeof fd !== 'number') {
      rval = createServerHandle('::', port, 6, fd);

      if (typeof rval === 'number') {
        rval = null;
        address = '0.0.0.0';
        addressType = 4;
      } else {
        address = '::';
        addressType = 6;
      }
    }

    if (rval === null)
      rval = createServerHandle(address, port, addressType, fd);

    if (typeof rval === 'number') {
      var error = exceptionWithHostPort(rval, 'listen', address, port);
      process.nextTick(emitErrorNT, this, error);
      return;
    }
    this._handle = rval;
  }

  this[async_id_symbol] = getNewAsyncId(this._handle);
  // 连接成功后回调
  this._handle.onconnection = onconnection;
  // handle关联的socket
  this._handle.owner = this;

  // Use a backlog of 512 entries. We pass 511 to the listen() call because
  // the kernel does: backlogsize = roundup_pow_of_two(backlogsize + 1);
  // which will thus give us a backlog of 512 entries.
  // 修改handle为listen状态
  var err = this._handle.listen(backlog || 511);
  // 出错则关闭并且触发error事件
  if (err) {
    var ex = exceptionWithHostPort(err, 'listen', address, port);
    this._handle.close();
    this._handle = null;
    nextTick(this[async_id_symbol], emitErrorNT, this, ex);
    return;
  }

  // generate connection key, this should be unique to the connection
  this._connectionKey = addressType + ':' + address + ':' + port;

  // unref the handle if the server was unref'ed prior to listening
  // 设置了unref状态（通过unref函数）则执行
  if (this._unref)
    this.unref();
  // nextTick触发回调，保存用户在listen后可以绑定事件
  nextTick(this[async_id_symbol], emitListeningNT, this);
}

Server.prototype._listen2 = setupListenHandle;  // legacy alias

function emitErrorNT(self, err) {
  self.emit('error', err);
}

// 触发listen成功的回调
function emitListeningNT(self) {
  // ensure handle hasn't closed
  if (self._handle)
    self.emit('listening');
}


function listenInCluster(server, address, port, addressType,
                         backlog, fd, exclusive) {
  exclusive = !!exclusive;

  if (cluster === null) cluster = require('cluster');

  if (cluster.isMaster || exclusive) {
    // Will create a new handle
    // _listen2 sets up the listened handle, it is still named like this
    // to avoid breaking code that wraps this method
    server._listen2(address, port, addressType, backlog, fd);
    return;
  }

  const serverQuery = {
    address: address,
    port: port,
    addressType: addressType,
    fd: fd,
    flags: 0
  };

  // Get the master's server handle, and listen on it
  cluster._getServer(server, serverQuery, listenOnMasterHandle);

  function listenOnMasterHandle(err, handle) {
    err = checkBindError(err, port, handle);

    if (err) {
      var ex = exceptionWithHostPort(err, 'bind', address, port);
      return server.emit('error', ex);
    }

    // Reuse master's server handle
    server._handle = handle;
    // _listen2 sets up the listened handle, it is still named like this
    // to avoid breaking code that wraps this method
    server._listen2(address, port, addressType, backlog, fd);
  }
}


Server.prototype.listen = function(...args) {
  // 处理入参，根据文档我们知道listen可以接收好几个参数，我们这里是只传了端口号9297
  var normalized = normalizeArgs(args);
  //  normalized = [{port: 9297}, null];
  var options = normalized[0];
  var cb = normalized[1];
  // 第一次listen的时候会创建，如果非空说明已经listen过
  if (this._handle) {
    throw new errors.Error('ERR_SERVER_ALREADY_LISTEN');
  }
  //
  var hasCallback = (cb !== null);
  if (hasCallback) {
    // listen成功的回调
    this.once('listening', cb);
  }
  var backlogFromArgs =
    // (handle, backlog) or (path, backlog) or (port, backlog)
    toNumber(args.length > 1 && args[1]) ||
    toNumber(args.length > 2 && args[2]);  // (port, host, backlog)

  options = options._handle || options.handle || options;
  // (handle[, backlog][, cb]) where handle is an object with a handle
  if (options instanceof TCP) {
    this._handle = options;
    this[async_id_symbol] = this._handle.getAsyncId();
    listenInCluster(this, null, -1, -1, backlogFromArgs);
    return this;
  }
  // (handle[, backlog][, cb]) where handle is an object with a fd
  if (typeof options.fd === 'number' && options.fd >= 0) {
    listenInCluster(this, null, null, null, backlogFromArgs, options.fd);
    return this;
  }

  // ([port][, host][, backlog][, cb]) where port is omitted,
  // that is, listen(), listen(null), listen(cb), or listen(null, cb)
  // or (options[, cb]) where options.port is explicitly set as undefined or
  // null, bind to an arbitrary unused port
  if (args.length === 0 || typeof args[0] === 'function' ||
      (typeof options.port === 'undefined' && 'port' in options) ||
      options.port === null) {
    options.port = 0;
  }
  // ([port][, host][, backlog][, cb]) where port is specified
  // or (options[, cb]) where options.port is specified
  // or if options.port is normalized as 0 before
  var backlog;
  if (typeof options.port === 'number' || typeof options.port === 'string') {
    if (!isLegalPort(options.port)) {
      throw new errors.RangeError('ERR_SOCKET_BAD_PORT', options.port);
    }
    backlog = options.backlog || backlogFromArgs;
    // start TCP server listening on host:port
    if (options.host) {
      lookupAndListen(this, options.port | 0, options.host, backlog,
                      options.exclusive);
    } else { // Undefined host, listens on unspecified address
      // Default addressType 4 will be used to search for master server
      listenInCluster(this, null, options.port | 0, 4,
                      backlog, undefined, options.exclusive);
    }
    return this;
  }

  // (path[, backlog][, cb]) or (options[, cb])
  // where path or options.path is a UNIX domain socket or Windows pipe
  if (options.path && isPipeName(options.path)) {
    var pipeName = this._pipeName = options.path;
    backlog = options.backlog || backlogFromArgs;
    listenInCluster(this, pipeName, -1, -1,
                    backlog, undefined, options.exclusive);
    return this;
  }

  throw new errors.Error('ERR_INVALID_OPT_VALUE',
                         'options',
                         util.inspect(options));
};
// dns完再listen
function lookupAndListen(self, port, address, backlog, exclusive) {
  dns.lookup(address, function doListen(err, ip, addressType) {
    if (err) {
      self.emit('error', err);
    } else {
      addressType = ip ? addressType : 4;
      listenInCluster(self, ip, port, addressType,
                      backlog, undefined, exclusive);
    }
  });
}

Object.defineProperty(Server.prototype, 'listening', {
  get: function() {
    return !!this._handle;
  },
  configurable: true,
  enumerable: true
});

Server.prototype.address = function() {
  if (this._handle && this._handle.getsockname) {
    var out = {};
    var err = this._handle.getsockname(out);
    if (err) {
      throw errnoException(err, 'address');
    }
    return out;
  } else if (this._pipeName) {
    return this._pipeName;
  } else {
    return null;
  }
};
// clientHandle代表一个和客户端建立tcp连接的实体
function onconnection(err, clientHandle) {
  var handle = this;
  var self = handle.owner;

  debug('onconnection');

  if (err) {
    self.emit('error', errnoException(err, 'accept'));
    return;
  }
  // 建立过多，关掉
  if (self.maxConnections && self._connections >= self.maxConnections) {
    clientHandle.close();
    return;
  }

  var socket = new Socket({
    handle: clientHandle,
    allowHalfOpen: self.allowHalfOpen,
    pauseOnCreate: self.pauseOnConnect
  });
  socket.readable = socket.writable = true;


  self._connections++;
  socket.server = self;
  socket._server = self;

  DTRACE_NET_SERVER_CONNECTION(socket);
  LTTNG_NET_SERVER_CONNECTION(socket);
  COUNTER_NET_SERVER_CONNECTION(socket);
  self.emit('connection', socket);
}


Server.prototype.getConnections = function(cb) {
  const self = this;

  function end(err, connections) {
    const asyncId = self._handle ? self[async_id_symbol] : null;
    nextTick(asyncId, cb, err, connections);
  }

  if (!this._usingWorkers) {
    end(null, this._connections);
    return this;
  }

  // Poll workers
  var left = this._workers.length;
  var total = this._connections;

  function oncount(err, count) {
    if (err) {
      left = -1;
      return end(err);
    }

    total += count;
    if (--left === 0) return end(null, total);
  }

  for (var n = 0; n < this._workers.length; n++) {
    this._workers[n].getConnections(oncount);
  }

  return this;
};

// 执行server的close
Server.prototype.close = function(cb) {
  // 触发回调
  if (typeof cb === 'function') {
    if (!this._handle) {
      this.once('close', function close() {
        cb(new errors.Error('ERR_SERVER_NOT_RUNNING'));
      });
    } else {
      this.once('close', cb);
    }
  }
  // 关闭底层资源
  if (this._handle) {
    this._handle.close();
    this._handle = null;
  }
  // 判断是否需要立刻触发close事件
  if (this._usingWorkers) {
    var left = this._workers.length;
    const onWorkerClose = () => {
      // 是否是最后一个worker
      if (--left !== 0) return;

      this._connections = 0;
      this._emitCloseIfDrained();
    };

    // Increment connections to be sure that, even if all sockets will be closed
    // during polling of workers, `close` event will be emitted only once.
    this._connections++;

    // Poll workers 关闭所有worker，然后触发server的close事件
    for (var n = 0; n < this._workers.length; n++)
      this._workers[n].close(onWorkerClose);
  } else {
    this._emitCloseIfDrained();
  }

  return this;
};
// server下的连接都close后触发server的close事件
Server.prototype._emitCloseIfDrained = function() {
  debug('SERVER _emitCloseIfDrained');

  if (this._handle || this._connections) {
    debug('SERVER handle? %j   connections? %d',
          !!this._handle, this._connections);
    return;
  }

  const asyncId = this._handle ? this[async_id_symbol] : null;
  nextTick(asyncId, emitCloseNT, this);
};


function emitCloseNT(self) {
  debug('SERVER: emit close');
  self.emit('close');
}


Server.prototype.listenFD = internalUtil.deprecate(function(fd, type) {
  return this.listen({ fd: fd });
}, 'Server.listenFD is deprecated. Use Server.listen({fd: <number>}) instead.',
                                                   'DEP0021');
// 
Server.prototype._setupWorker = function(socketList) {
  this._usingWorkers = true;
  this._workers.push(socketList);
  socketList.once('exit', (socketList) => {
    const index = this._workers.indexOf(socketList);
    this._workers.splice(index, 1);
  });
};

Server.prototype.ref = function() {
  this._unref = false;

  if (this._handle)
    this._handle.ref();

  return this;
};

Server.prototype.unref = function() {
  this._unref = true;

  if (this._handle)
    this._handle.unref();

  return this;
};

var _setSimultaneousAccepts;

if (process.platform === 'win32') {
  var simultaneousAccepts;

  _setSimultaneousAccepts = function(handle) {
    if (handle === undefined) {
      return;
    }

    if (simultaneousAccepts === undefined) {
      simultaneousAccepts = (process.env.NODE_MANY_ACCEPTS &&
                             process.env.NODE_MANY_ACCEPTS !== '0');
    }

    if (handle._simultaneousAccepts !== simultaneousAccepts) {
      handle.setSimultaneousAccepts(simultaneousAccepts);
      handle._simultaneousAccepts = simultaneousAccepts;
    }
  };
} else {
  _setSimultaneousAccepts = function(handle) {};
}

module.exports = {
  _createServerHandle: createServerHandle,
  _normalizeArgs: normalizeArgs,
  _setSimultaneousAccepts,
  connect,
  createConnection: connect,
  createServer,
  isIP: isIP,
  isIPv4: isIPv4,
  isIPv6: isIPv6,
  Server,
  Socket,
  Stream: Socket, // Legacy naming
};
