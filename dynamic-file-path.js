/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
    "use strict";
    var fs = require("fs-extra");
    var os = require("os");
    var path = require("path");
    var iconv = require("iconv-lite")
    var mustache = require("mustache");

    var baseDynamicFilePathStruct = "dynamicFilePath"

    function encode(data, enc) {
        if (enc !== "none") {
            return iconv.encode(data, enc);
        }
        return Buffer.from(data);
    }

    /*
    * DynamicFileNode represents writing/deleting a file
    * */
    function DynamicFileNode(n) {
        // Write/delete a file
        RED.nodes.createNode(this, n);
        this.filename = n.filename;
        this.appendNewline = n.appendNewline;
        this.overwriteFile = n.overwriteFile.toString();
        this.createDir = n.createDir || false;
        this.encoding = n.encoding || "none";
        var node = this;
        node.wstream = null;
        node.msgQueue = [];
        node.closing = false;
        node.closeCallback = null;

        function processMsg(msg, nodeSend, done) {

            if (!msg.hasOwnProperty(baseDynamicFilePathStruct)) {
                node.error(this._("dynamic-file.errors.didntFindBaseStruct", {error: "payload should include struct dynamicFilePath"}), msg);
                done()
            }
            if (
                msg.hasOwnProperty(baseDynamicFilePathStruct) &&
                msg[baseDynamicFilePathStruct].hasOwnProperty("debug") &&
                msg[baseDynamicFilePathStruct].debug === "true"
            ) {
                console.log("function processMsg debug ==> msg=%s, nodeSend=%s, done=%s", JSON.stringify(msg), nodeSend, done);
            }
            var filename = node.filename || msg.filename || "";
            var fullFilename = mustache.render(filename, msg);
            if (
                msg.hasOwnProperty("payload") && (typeof msg.payload !== "undefined") &&
                msg.payload.hasOwnProperty(baseDynamicFilePathStruct) &&
                msg.payload[baseDynamicFilePathStruct].hasOwnProperty("debug") &&
                msg.payload[baseDynamicFilePathStruct].debug === "true"
            ) {
                console.log("function processMsg debug ==> msg=%s, nodeSend=%s, done=%s, fullFilename=%s", JSON.stringify(msg), nodeSend, done, fullFilename);
            }
            if (filename && RED.settings.fileWorkingDirectory && !path.isAbsolute(filename)) {
                fullFilename = path.resolve(path.join(RED.settings.fileWorkingDirectory, filename));
            }
            if ((!node.filename) && (!node.tout)) {
                node.tout = setTimeout(function () {
                    node.status({fill: "grey", shape: "dot", text: filename});
                    clearTimeout(node.tout);
                    node.tout = null;
                }, 333);
            }
            if (filename === "") {
                node.warn(RED._("file.errors.nofilename"));
                done();
            } else if (node.overwriteFile === "delete") {
                fs.unlink(fullFilename, function (err) {
                    if (err) {
                        node.error(RED._("file.errors.deletefail", {error: err.toString()}), msg);
                    } else {
                        node.debug(RED._("file.status.deletedfile", {file: filename}));
                        nodeSend(msg);
                    }
                    done();
                });
            } else if (msg.hasOwnProperty("payload") && (typeof msg.payload !== "undefined")) {
                var dir = path.dirname(fullFilename);
                if (node.createDir) {
                    try {
                        fs.ensureDirSync(dir);
                    } catch (err) {
                        node.error(RED._("file.errors.createfail", {error: err.toString()}), msg);
                        done();
                        return;
                    }
                }

                var data = msg.payload;
                if ((typeof data === "object") && (!Buffer.isBuffer(data))) {
                    data = JSON.stringify(data);
                }
                if (typeof data === "boolean") {
                    data = data.toString();
                }
                if (typeof data === "number") {
                    data = data.toString();
                }
                if ((node.appendNewline) && (!Buffer.isBuffer(data))) {
                    data += os.EOL;
                }
                var buf;
                if (node.encoding === "setbymsg") {
                    buf = encode(data, msg.encoding || "none");
                } else {
                    buf = encode(data, node.encoding);
                }
                if (node.overwriteFile === "true") {
                    var wstream = fs.createWriteStream(fullFilename, {encoding: 'binary', flags: 'w', autoClose: true});
                    node.wstream = wstream;
                    wstream.on("error", function (err) {
                        node.error(RED._("file.errors.writefail", {error: err.toString()}), msg);
                        done();
                    });
                    wstream.on("open", function () {
                        wstream.once("close", function () {
                            nodeSend(msg);
                            done();
                        });
                        wstream.end(buf);
                    })
                    return;
                } else {
                    // Append mode
                    var recreateStream = !node.wstream || !node.filename;
                    if (node.wstream && node.wstreamIno) {
                        // There is already a stream open and we have the inode
                        // of the file. Check the file hasn't been deleted
                        // or deleted and recreated.
                        try {
                            var stat = fs.statSync(fullFilename);
                            // File exists - check the inode matches
                            if (stat.ino !== node.wstreamIno) {
                                // The file has been recreated. Close the current
                                // stream and recreate it
                                recreateStream = true;
                                node.wstream.end();
                                delete node.wstream;
                                delete node.wstreamIno;
                            }
                        } catch (err) {
                            // File does not exist
                            recreateStream = true;
                            node.wstream.end();
                            delete node.wstream;
                            delete node.wstreamIno;
                        }
                    }
                    if (recreateStream) {
                        node.wstream = fs.createWriteStream(fullFilename, {
                            encoding: 'binary',
                            flags: 'a',
                            autoClose: true
                        });
                        node.wstream.on("open", function (fd) {
                            try {
                                var stat = fs.statSync(fullFilename);
                                node.wstreamIno = stat.ino;
                            } catch (err) {
                            }
                        });
                        node.wstream.on("error", function (err) {
                            node.error(RED._("file.errors.appendfail", {error: err.toString()}), msg);
                            done();
                        });
                    }
                    if (node.filename) {
                        // Static filename - write and reuse the stream next time
                        node.wstream.write(buf, function () {
                            nodeSend(msg);
                            done();
                        });
                    } else {
                        // Dynamic filename - write and close the stream
                        node.wstream.once("close", function () {
                            nodeSend(msg);
                            delete node.wstream;
                            delete node.wstreamIno;
                            done();
                        });
                        node.wstream.end(buf);
                    }
                }
            } else {
                done();
            }
        }

        function processQueue(queue) {
            var event = queue[0];
            processMsg(event.msg, event.send, function () {
                event.done();
                queue.shift();
                if (queue.length > 0) {
                    processQueue(queue);
                } else if (node.closing) {
                    closeNode();
                }
            });
        }

        this.on("input", function (msg, nodeSend, nodeDone) {
            var msgQueue = node.msgQueue;
            msgQueue.push({
                msg: msg,
                send: nodeSend,
                done: nodeDone
            })
            if (msgQueue.length > 1) {
                // pending write exists
                return;
            }
            try {
                processQueue(msgQueue);
            } catch (e) {
                node.msgQueue = [];
                if (node.closing) {
                    closeNode();
                }
                throw e;
            }
        });

        function closeNode() {
            if (node.wstream) {
                node.wstream.end();
            }
            if (node.tout) {
                clearTimeout(node.tout);
            }
            node.status({});
            var cb = node.closeCallback;
            node.closeCallback = null;
            node.closing = false;
            if (cb) {
                cb();
            }
        }

        this.on('close', function (done) {
            if (node.closing) {
                // already closing
                return;
            }
            node.closing = true;
            if (done) {
                node.closeCallback = done;
            }
            if (node.msgQueue.length > 0) {
                // close after queue processed
                return;
            } else {
                closeNode();
            }
        });
    }

    RED.nodes.registerType("dynamic-file", DynamicFileNode);
}