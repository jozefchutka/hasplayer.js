/*
 * The copyright in this software is being made available under the BSD License, included below. This software may be subject to other third party and contributor rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Digital Primates
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 * •  Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 * •  Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 * •  Neither the name of the Digital Primates nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
MediaPlayer.dependencies.SourceBufferExtensions = function () {
    "use strict";
    this.system = undefined;
    this.manifestExt = undefined;
};

MediaPlayer.dependencies.SourceBufferExtensions.prototype = {

    constructor: MediaPlayer.dependencies.SourceBufferExtensions,

    createSourceBuffer: function (mediaSource, codec) {
        "use strict";

        var buffer = null;

        if (!mediaSource) {
            return null;
        }

        try {
            buffer = mediaSource.addSourceBuffer(codec);
        } catch(ex) {
            // For text track not supported by MSE, we try to create corresponding specific source buffer
            if (this.manifestExt.getIsTextTrack(codec)) {
                if ((codec === 'text/vtt') || (codec === 'text/ttml')) {
                    buffer = this.system.getObject("textSourceBuffer");
                } else if (codec === 'application/ttml+xml+mp4' || codec === 'application/mp4' || codec === 'application/ttml+xml') {
                    buffer = this.system.getObject("textTTMLXMLMP4SourceBuffer");
                } else {
                    throw ex;
                }
            } else {
                throw ex;
            }
        }
        return buffer;
    },

    removeSourceBuffer: function (mediaSource, buffer) {
        "use strict";
        try {
            mediaSource.removeSourceBuffer(buffer);
        } catch (ex) {
        }
    },

    getBufferRange: function (buffer, time, tolerance) {
        "use strict";
        var ranges = null,
            start = 0,
            end = 0,
            firstStart = null,
            lastEnd = null,
            gap = 0,
            toler = (tolerance || 0.03),
            len,
            i;

        try {
            ranges = buffer.buffered;
        } catch(ex) {
            return null;
        }

        if (ranges) {
            for (i = 0, len = ranges.length; i < len; i += 1) {
                start = ranges.start(i);
                end = ranges.end(i);
                if (firstStart === null) {
                    gap = Math.abs(start - time);
                    if (time >= start && time < end) {
                        // start the range
                        firstStart = start;
                        lastEnd = end;
                        continue;
                    } else if (gap <= toler) {
                        // start the range even though the buffer does not contain time 0
                        firstStart = start;
                        lastEnd = end;
                        continue;
                    }
                } else {
                    gap = start - lastEnd;
                    if (gap <= toler) {
                        // the discontinuity is smaller than the tolerance, combine the ranges
                        lastEnd = end;
                    } else {
                        break;
                    }
                }
            }

            if (firstStart !== null) {
                return {start: firstStart, end: lastEnd};
            }
        }

        return null;
    },

    getAllRanges: function(buffer) {
        var ranges = null;

        try{
            ranges = buffer.buffered;
            return ranges;
        } catch (ex) {
            return null;
        }
    },

    getBufferLength: function (buffer, time, tolerance) {
        "use strict";

        var self = this,
            range,
            length;

        range = self.getBufferRange(buffer, time, tolerance);

        if (range === null) {
            length = 0;
        } else {
            length = range.end - time;
        }

        return length;
    },

    waitForUpdateEnd: function(buffer) {
        "use strict";
        var defer = Q.defer(),
            intervalId,
            CHECK_INTERVAL = 50,
            checkIsUpdateEnded = function() {
                // if updating is still in progress do nothing and wait for the next check again.
                if (buffer.updating) {
                    return;
                }
                // updating is completed, now we can stop checking and resolve the promise
                clearInterval(intervalId);
                defer.resolve(true);
            },
            updateEndHandler = function() {
                if (buffer.updating) {
                    return;
                }

                buffer.removeEventListener("updateend", updateEndHandler, false);
                defer.resolve(true);
            };

            if (!buffer.updating) {
                defer.resolve(true);
                return defer.promise;
            }
        // use updateend event if possible
        if (typeof buffer.addEventListener === "function") {
            try {
                buffer.addEventListener("updateend", updateEndHandler, false);
            } catch (err) {
                // use setInterval to periodically check if updating has been completed
                intervalId = setInterval(checkIsUpdateEnded, CHECK_INTERVAL);
            }
        } else {
            // use setInterval to periodically check if updating has been completed
            intervalId = setInterval(checkIsUpdateEnded, CHECK_INTERVAL);
        }

        return defer.promise;
    },

    append: function (buffer, bytes, sync) {
        var deferred = Q.defer(),
            self = this;

        self.waitForUpdateEnd(buffer).then(function() {
            try {
                if ("append" in buffer) {
                    buffer.append(bytes);
                } else if ("appendBuffer" in buffer) {
                    buffer.appendBuffer(bytes);
                }

                if (sync) {
                    deferred.resolve();
                } else {
                    // updating is in progress, we should wait for it to complete before signaling that this operation is done
                    self.waitForUpdateEnd(buffer).then(
                        function() {
                            deferred.resolve();
                        }
                    );
                }
            } catch (err) {
                deferred.reject({err: err, data: bytes});
            }
        });

        return deferred.promise;
    },

    remove: function (buffer, start, end, duration, mediaSource, sync) {
        var deferred = Q.defer(),
            self = this;

        self.waitForUpdateEnd(buffer).then(function() {
            try {
                // make sure that the given time range is correct. Otherwise we will get InvalidAccessError
                if ((start >= 0) && (start < duration) && (end > start) && (mediaSource.readyState !== "ended")) {
                    buffer.remove(start, end);
                }
                
                //workaround in order to remove all the cues in the textTrack from the video element.
                //end parameter equals the video.duration. The use case of a dash stream with a full TTML subtitles file has an issue because video duration could be NaN. It occurs
                //after the manifest has been parsed, a call to MediaSource.setDuration is made but after a few ms, a duration change event occurs with a value of NaN. The origin of this issue may be
                //that no media segments have been pushed.
                //So, all the buffer is removed. 
                if (isNaN(end) && (mediaSource.readyState !== "ended")) {
                    buffer.remove(start);   
                }

                if (sync) {
                    deferred.resolve();
                } else {
                    // updating is in progress, we should wait for it to complete before signaling that this operation is done
                    self.waitForUpdateEnd(buffer).then(
                        function() {
                            deferred.resolve();
                        }
                    );
                }
            } catch (err) {
                deferred.reject(err);
            }
        });

        return deferred.promise;
    },

    abort: function (mediaSource, buffer) {
        "use strict";
            try {
                if (mediaSource.readyState === "open") {
                    buffer.abort();
                }
            } catch(ex){
            }
    }
};
