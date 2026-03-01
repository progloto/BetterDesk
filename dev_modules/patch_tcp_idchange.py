#!/usr/bin/env python3
"""Patch TCP RegisterPk handler to support ID change in rendezvous_server.rs"""
import sys

filepath = sys.argv[1] if len(sys.argv) > 1 else 'rustdesk-server-1.1.14/src/rendezvous_server.rs'

with open(filepath, 'r') as f:
    content = f.read()

old_tcp_handler = '''                Some(rendezvous_message::Union::RegisterPk(_)) => {
                    let res = register_pk_response::Result::NOT_SUPPORT;
                    let mut msg_out = RendezvousMessage::new();
                    msg_out.set_register_pk_response(RegisterPkResponse {
                        result: res.into(),
                        ..Default::default()
                    });
                    Self::send_to_sink(sink, msg_out).await;
                }'''

new_tcp_handler = '''                Some(rendezvous_message::Union::RegisterPk(rk)) => {
                    if rk.uuid.is_empty() || rk.pk.is_empty() {
                        return false;
                    }
                    let id = rk.id;
                    let old_id = rk.old_id;
                    let ip = addr.ip().to_string();

                    // ID Change flow via TCP - desktop client uses this path
                    if !old_id.is_empty() && old_id != id {
                        log::info!("TCP ID change request: {} -> {} from {}", old_id, id, ip);

                        let result = if id.len() < 6 || id.len() > 16 {
                            log::warn!("Invalid ID format for change: {}", id);
                            register_pk_response::Result::UUID_MISMATCH
                        } else if !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                            log::warn!("Invalid ID characters for change: {}", id);
                            register_pk_response::Result::UUID_MISMATCH
                        } else {
                            self.pm.change_id(
                                old_id, id, addr, rk.uuid, rk.pk, ip
                            ).await
                        };

                        let mut msg_out = RendezvousMessage::new();
                        msg_out.set_register_pk_response(RegisterPkResponse {
                            result: result.into(),
                            ..Default::default()
                        });
                        Self::send_to_sink(sink, msg_out).await;
                    } else {
                        // Normal RegisterPk via TCP - not supported (use UDP)
                        let mut msg_out = RendezvousMessage::new();
                        msg_out.set_register_pk_response(RegisterPkResponse {
                            result: register_pk_response::Result::NOT_SUPPORT.into(),
                            ..Default::default()
                        });
                        Self::send_to_sink(sink, msg_out).await;
                    }
                }'''

if old_tcp_handler not in content:
    print('ERROR: Could not find TCP RegisterPk handler to replace!')
    sys.exit(1)

new_content = content.replace(old_tcp_handler, new_tcp_handler)

with open(filepath, 'w') as f:
    f.write(new_content)

print(f'OK: TCP RegisterPk handler patched ({len(content)} -> {len(new_content)} bytes)')
