/**
 * BetterDesk Web Remote Client - Protocol Handler
 * Implements RustDesk rendezvous and peer-to-peer protocol using protobuf
 */

/* global protobuf, RDConnection, RDCrypto */

// eslint-disable-next-line no-unused-vars
class RDProtocol {
    constructor() {
        /** @type {Object} Loaded protobuf root */
        this.protoRoot = null;
        /** @type {Object} Message types cache */
        this.types = {};
        /** @type {boolean} */
        this.loaded = false;
    }

    /**
     * Load and parse .proto files
     */
    async load() {
        if (this.loaded) return;

        this.protoRoot = await protobuf.load([
            '/protos/rendezvous.proto',
            '/protos/message.proto'
        ]);

        // Cache commonly used message types
        this.types.RendezvousMessage = this.protoRoot.lookupType('hbb.RendezvousMessage');
        this.types.Message = this.protoRoot.lookupType('hbb.Message');
        this.types.PunchHoleRequest = this.protoRoot.lookupType('hbb.PunchHoleRequest');
        this.types.PunchHoleResponse = this.protoRoot.lookupType('hbb.PunchHoleResponse');
        this.types.RequestRelay = this.protoRoot.lookupType('hbb.RequestRelay');
        this.types.RelayResponse = this.protoRoot.lookupType('hbb.RelayResponse');
        this.types.LoginRequest = this.protoRoot.lookupType('hbb.LoginRequest');
        this.types.LoginResponse = this.protoRoot.lookupType('hbb.LoginResponse');
        this.types.SignedId = this.protoRoot.lookupType('hbb.SignedId');
        this.types.PublicKey = this.protoRoot.lookupType('hbb.PublicKey');
        this.types.Hash = this.protoRoot.lookupType('hbb.Hash');
        this.types.MouseEvent = this.protoRoot.lookupType('hbb.MouseEvent');
        this.types.KeyEvent = this.protoRoot.lookupType('hbb.KeyEvent');
        this.types.VideoFrame = this.protoRoot.lookupType('hbb.VideoFrame');
        this.types.AudioFrame = this.protoRoot.lookupType('hbb.AudioFrame');
        this.types.CursorData = this.protoRoot.lookupType('hbb.CursorData');
        this.types.CursorPosition = this.protoRoot.lookupType('hbb.CursorPosition');
        this.types.TestDelay = this.protoRoot.lookupType('hbb.TestDelay');
        this.types.Misc = this.protoRoot.lookupType('hbb.Misc');
        this.types.OptionMessage = this.protoRoot.lookupType('hbb.OptionMessage');
        this.types.SupportedDecoding = this.protoRoot.lookupType('hbb.SupportedDecoding');
        this.types.Clipboard = this.protoRoot.lookupType('hbb.Clipboard');
        this.types.PeerInfo = this.protoRoot.lookupType('hbb.PeerInfo');
        this.types.IdPk = this.protoRoot.lookupType('hbb.IdPk');
        this.types.Resolution = this.protoRoot.lookupType('hbb.Resolution');
        this.types.ChatMessage = this.protoRoot.lookupType('hbb.ChatMessage');
        this.types.TogglePrivacyMode = this.protoRoot.lookupType('hbb.TogglePrivacyMode');
        this.types.SwitchDisplay = this.protoRoot.lookupType('hbb.SwitchDisplay');

        // Enums
        this.enums = {};
        this.enums.ConnType = this.protoRoot.lookupEnum('hbb.ConnType');
        this.enums.NatType = this.protoRoot.lookupEnum('hbb.NatType');
        this.enums.ControlKey = this.protoRoot.lookupEnum('hbb.ControlKey');
        this.enums.KeyboardMode = this.protoRoot.lookupEnum('hbb.KeyboardMode');
        this.enums.ImageQuality = this.protoRoot.lookupEnum('hbb.ImageQuality');
        this.enums.ClipboardFormat = this.protoRoot.lookupEnum('hbb.ClipboardFormat');

        this.loaded = true;
    }

    // ---- Encoding helpers ----

    /**
     * Encode a RendezvousMessage with RustDesk variable-length frame header
     * (used for direct rendezvous communication, no encryption)
     */
    encodeRendezvous(msgObj) {
        const msg = this.types.RendezvousMessage.create(msgObj);
        const buf = this.types.RendezvousMessage.encode(msg).finish();
        return this._encodeFrame(buf);
    }

    /**
     * Serialize a Message to raw protobuf bytes (NO frame header)
     * Use this when encryption will be applied before framing
     */
    serializeMessage(msgObj) {
        const msg = this.types.Message.create(msgObj);
        return this.types.Message.encode(msg).finish();
    }

    /**
     * Encode a Message (peer-to-peer) with RustDesk variable-length frame header
     * (used when no encryption is active)
     */
    encodeMessage(msgObj) {
        return this._encodeFrame(this.serializeMessage(msgObj));
    }

    /**
     * Add frame header to raw bytes (e.g. after encryption)
     * @param {Uint8Array} rawBytes
     * @returns {Uint8Array}
     */
    frameBytes(rawBytes) {
        return this._encodeFrame(rawBytes);
    }

    /**
     * Decode a RendezvousMessage from raw protobuf bytes (frame header already stripped)
     * @param {Uint8Array} protoBytes - Raw protobuf payload
     */
    decodeRendezvous(protoBytes) {
        return this.types.RendezvousMessage.decode(protoBytes);
    }

    /**
     * Decode a Message (peer-to-peer) from raw protobuf bytes (frame header already stripped)
     * @param {Uint8Array} protoBytes - Raw protobuf payload
     */
    decodeMessage(protoBytes) {
        return this.types.Message.decode(protoBytes);
    }

    // ---- Protocol message builders ----

    /**
     * Build PunchHoleRequest for connecting to a device
     * @param {string} deviceId
     * @param {string} [serverKey] - Server public key (base64) for licence_key validation
     */
    buildPunchHoleRequest(deviceId, serverKey) {
        return {
            punchHoleRequest: {
                id: deviceId,
                natType: this.enums.NatType.values.SYMMETRIC, // Browser always NAT
                licenceKey: serverKey || '',
                connType: this.enums.ConnType.values.DEFAULT_CONN,
                token: '',
                version: 'BetterDesk-Web/1.0',
                forceRelay: true // Browser must use relay
            }
        };
    }

    /**
     * Build RequestRelay message
     * @param {string} deviceId - Target device ID
     * @param {string} uuid - Relay session UUID (from RelayResponse)
     * @param {string} relayServer - Relay server address
     * @param {string} [serverKey] - Server public key for licence_key validation (hbbr checks this)
     */
    buildRequestRelay(deviceId, uuid, relayServer, serverKey) {
        return {
            requestRelay: {
                id: deviceId,
                uuid: uuid,
                relayServer: relayServer || '',
                licenceKey: serverKey || '',
                secure: false,
                connType: this.enums.ConnType.values.DEFAULT_CONN,
                token: ''
            }
        };
    }

    /**
     * Build PublicKey message for secure handshake
     */
    buildPublicKey(asymPk, symKey) {
        return {
            publicKey: {
                asymmetricValue: asymPk,
                symmetricValue: symKey
            }
        };
    }

    /**
     * Build LoginRequest message
     * @param {Uint8Array} passwordHash
     * @param {Object} opts
     */
    buildLoginRequest(passwordHash, opts = {}) {
        // Dynamically detect codec support
        const hasWebCodecs = typeof VideoDecoder !== 'undefined';
        const hasJMuxer = typeof JMuxer !== 'undefined';

        return {
            loginRequest: {
                username: opts.username || '',
                password: passwordHash,
                myId: opts.myId || 'web-client',
                myName: opts.myName || 'BetterDesk Web',
                myPlatform: 'Web',
                version: 'BetterDesk-Web/1.0',
                sessionId: Date.now(),
                option: {
                    imageQuality: this.enums.ImageQuality.values.Balanced,
                    supportedDecoding: {
                        abilityVp9: hasWebCodecs ? 1 : 0,
                        abilityH264: (hasWebCodecs || hasJMuxer) ? 1 : 0,
                        abilityAv1: hasWebCodecs ? 1 : 0,
                        abilityVp8: hasWebCodecs ? 1 : 0,
                        prefer: hasWebCodecs ? 0 : 2 // Auto when WebCodecs, H264 when fallback
                    },
                    customFps: opts.fps || 30,
                    showRemoteCursor: 2, // Yes
                    disableAudio: opts.disableAudio ? 2 : 1,
                    disableClipboard: 1, // No
                    lockAfterSessionEnd: 1 // No
                }
            }
        };
    }

    /**
     * Build MouseEvent message
     */
    buildMouseEvent(mask, x, y, modifiers = []) {
        return {
            mouseEvent: { mask, x, y, modifiers }
        };
    }

    /**
     * Build KeyEvent message
     */
    buildKeyEvent(keyData) {
        return {
            keyEvent: keyData
        };
    }

    /**
     * Build TestDelay message (ping)
     */
    buildTestDelay() {
        return {
            testDelay: {
                time: Date.now(),
                fromClient: true,
                lastDelay: 0,
                targetBitrate: 0
            }
        };
    }

    /**
     * Build Clipboard message
     */
    buildClipboard(text) {
        const encoder = new TextEncoder();
        return {
            clipboard: {
                compress: false,
                content: encoder.encode(text),
                format: this.enums.ClipboardFormat.values.Text
            }
        };
    }

    /**
     * Build a Misc message wrapping an OptionMessage for mid-session setting changes.
     * BoolOption values: NotSet=0, No=1, Yes=2
     * @param {Object} opts - OptionMessage fields
     */
    buildOptionMisc(opts = {}) {
        const optionMsg = {};
        if (opts.imageQuality !== undefined) {
            optionMsg.imageQuality = this.enums.ImageQuality.values[opts.imageQuality] || 0;
        }
        if (opts.customImageQuality !== undefined) {
            optionMsg.customImageQuality = opts.customImageQuality;
        }
        if (opts.customFps !== undefined) {
            optionMsg.customFps = opts.customFps;
        }
        if (opts.lockAfterSessionEnd !== undefined) {
            optionMsg.lockAfterSessionEnd = opts.lockAfterSessionEnd ? 2 : 1;
        }
        if (opts.showRemoteCursor !== undefined) {
            optionMsg.showRemoteCursor = opts.showRemoteCursor ? 2 : 1;
        }
        if (opts.privacyMode !== undefined) {
            optionMsg.privacyMode = opts.privacyMode ? 2 : 1;
        }
        if (opts.blockInput !== undefined) {
            optionMsg.blockInput = opts.blockInput ? 2 : 1;
        }
        if (opts.disableAudio !== undefined) {
            optionMsg.disableAudio = opts.disableAudio ? 2 : 1;
        }
        if (opts.disableClipboard !== undefined) {
            optionMsg.disableClipboard = opts.disableClipboard ? 2 : 1;
        }
        if (opts.disableKeyboard !== undefined) {
            optionMsg.disableKeyboard = opts.disableKeyboard ? 2 : 1;
        }
        return {
            misc: { option: optionMsg }
        };
    }

    /**
     * Build a Misc message for various control commands
     * @param {string} field - Misc oneof field name
     * @param {*} value - Field value
     */
    buildMisc(field, value) {
        const misc = {};
        misc[field] = value;
        return { misc: misc };
    }

    /**
     * Build ChatMessage wrapped in Misc
     * @param {string} text
     */
    buildChatMessage(text) {
        return {
            misc: {
                chatMessage: { text: text }
            }
        };
    }

    /**
     * Build TogglePrivacyMode wrapped in Misc
     * @param {boolean} on
     */
    buildTogglePrivacyMode(on) {
        return {
            misc: {
                togglePrivacyMode: {
                    implKey: 'privacy_mode_impl_virtual_display',
                    on: on
                }
            }
        };
    }

    // ---- Message parsing helpers ----

    /**
     * Get the active field name from a oneof message
     */
    getOneOfField(msg, oneofName) {
        if (!msg) return null;
        // protobufjs stores the active field name directly
        for (const key of Object.keys(msg)) {
            if (key !== oneofName && msg[key] != null) {
                return key;
            }
        }
        return null;
    }

    /**
     * Detect video codec from VideoFrame message
     */
    detectVideoCodec(videoFrame) {
        if (videoFrame.vp9s) return 'vp9';
        if (videoFrame.h264s) return 'h264';
        if (videoFrame.h265s) return 'h265';
        if (videoFrame.vp8s) return 'vp8';
        if (videoFrame.av1s) return 'av1';
        if (videoFrame.rgb) return 'rgb';
        if (videoFrame.yuv) return 'yuv';
        return null;
    }

    /**
     * Extract encoded frames from VideoFrame
     */
    getEncodedFrames(videoFrame) {
        const codec = this.detectVideoCodec(videoFrame);
        if (!codec || codec === 'rgb' || codec === 'yuv') return [];

        const key = codec + 's';
        const container = videoFrame[key];
        if (!container || !container.frames) return [];

        return container.frames.map(f => ({
            data: f.data,
            key: f.key,
            pts: f.pts,
            codec: codec
        }));
    }

    // ---- RustDesk Variable-Length Frame Codec ----
    // hbb_common/src/bytes_codec.rs uses a variable-length header:
    //   bottom 2 bits of byte 0 = (header_length - 1)
    //   remaining bits (shifted right 2) = payload length
    // Header is 1-4 bytes, little-endian.
    //   1 byte:  payload ≤ 63 bytes
    //   2 bytes: payload ≤ 16383 bytes
    //   3 bytes: payload ≤ 4194303 bytes
    //   4 bytes: payload ≤ 1073741823 bytes

    /**
     * Encode protobuf bytes into a RustDesk frame (variable-length header + payload)
     * @param {Uint8Array} buf - Raw protobuf bytes
     * @returns {Uint8Array}
     */
    _encodeFrame(buf) {
        const len = buf.length;
        let header;

        if (len <= 0x3F) {
            header = new Uint8Array(1);
            header[0] = (len << 2); // bottom 2 bits = 0b00
        } else if (len <= 0x3FFF) {
            header = new Uint8Array(2);
            const val = (len << 2) | 0x1; // bottom 2 bits = 0b01
            header[0] = val & 0xFF;
            header[1] = (val >> 8) & 0xFF;
        } else if (len <= 0x3FFFFF) {
            header = new Uint8Array(3);
            const val = (len << 2) | 0x2; // bottom 2 bits = 0b10
            header[0] = val & 0xFF;
            header[1] = (val >> 8) & 0xFF;
            header[2] = (val >> 16) & 0xFF;
        } else if (len <= 0x3FFFFFFF) {
            header = new Uint8Array(4);
            const val = (len << 2) | 0x3; // bottom 2 bits = 0b11
            header[0] = val & 0xFF;
            header[1] = (val >> 8) & 0xFF;
            header[2] = (val >> 16) & 0xFF;
            header[3] = (val >>> 24) & 0xFF;
        } else {
            throw new Error('Frame too large');
        }

        const result = new Uint8Array(header.length + buf.length);
        result.set(header);
        result.set(buf, header.length);
        return result;
    }

    /**
     * Try to decode one frame from a byte buffer at the given offset
     * @param {Uint8Array} bytes
     * @param {number} offset
     * @returns {{ data: Uint8Array, consumed: number } | null} null if incomplete
     */
    _decodeFrame(bytes, offset) {
        if (offset >= bytes.length) return null;

        const firstByte = bytes[offset];
        const headLen = (firstByte & 0x3) + 1;

        if (offset + headLen > bytes.length) return null;

        let n = bytes[offset];
        if (headLen > 1) n |= bytes[offset + 1] << 8;
        if (headLen > 2) n |= bytes[offset + 2] << 16;
        if (headLen > 3) n |= bytes[offset + 3] << 24;
        n >>>= 2; // unsigned right shift to get payload length

        if (offset + headLen + n > bytes.length) return null;

        return {
            data: bytes.slice(offset + headLen, offset + headLen + n),
            consumed: headLen + n
        };
    }

    /**
     * Create a stateful stream decoder that handles TCP reassembly
     * Feed it raw WebSocket binary data chunks, and it returns complete protobuf frames.
     * Uses a pre-allocated growing buffer to avoid O(n²) copies on every chunk.
     * @returns {{ feed: (data: ArrayBuffer|Uint8Array) => Uint8Array[] }}
     */
    createStreamDecoder() {
        let buffer = new Uint8Array(0);
        /** @type {number} Valid data length within buffer (buffer.length may be larger) */
        let dataLen = 0;
        const self = this;

        return {
            /**
             * Feed raw data from WebSocket and extract complete frames
             * @param {ArrayBuffer|Uint8Array} data
             * @returns {Uint8Array[]} Array of raw protobuf payloads (without frame headers)
             */
            feed(data) {
                const incoming = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

                // Append to buffer (grow capacity if needed)
                const needed = dataLen + incoming.length;
                if (needed > buffer.length) {
                    // Grow to at least 2x current or needed, whichever is larger
                    const newCap = Math.max(needed, buffer.length * 2, 4096);
                    const newBuf = new Uint8Array(newCap);
                    if (dataLen > 0) newBuf.set(buffer.subarray(0, dataLen));
                    buffer = newBuf;
                }
                buffer.set(incoming, dataLen);
                dataLen += incoming.length;

                const frames = [];
                let offset = 0;

                // Decode frames using a view of the valid portion
                const view = buffer.subarray(0, dataLen);
                while (offset < dataLen) {
                    const frame = self._decodeFrame(view, offset);
                    if (!frame) break; // Incomplete frame, wait for more data
                    frames.push(frame.data);
                    offset += frame.consumed;
                }

                // Compact: move unconsumed bytes to front of buffer
                if (offset > 0) {
                    const remaining = dataLen - offset;
                    if (remaining > 0) {
                        buffer.copyWithin(0, offset, dataLen);
                    }
                    dataLen = remaining;
                }

                return frames;
            },

            /** Reset internal buffer */
            reset() {
                buffer = new Uint8Array(0);
                dataLen = 0;
            }
        };
    }
}

window.RDProtocol = RDProtocol;
