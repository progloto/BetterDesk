#!/usr/bin/env python3
"""Fix TCP RegisterPk handler - remove early uuid/pk check that silently drops connection,
   and add debug logging to diagnose the actual flow."""
import sys

filepath = sys.argv[1] if len(sys.argv) > 1 else 'rustdesk-server-1.1.14/src/rendezvous_server.rs'

with open(filepath, 'r') as f:
    content = f.read()

old_handler = '''                Some(rendezvous_message::Union::RegisterPk(rk)) => {
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

new_handler = '''                Some(rendezvous_message::Union::RegisterPk(rk)) => {
                    let id = rk.id.clone();
                    let old_id = rk.old_id.clone();
                    let ip = addr.ip().to_string();
                    log::info!("TCP RegisterPk received: id={}, old_id={}, uuid_len={}, pk_len={}, from {}",
                        id, old_id, rk.uuid.len(), rk.pk.len(), ip);

                    // ID Change flow via TCP - desktop client uses this path
                    if !old_id.is_empty() && old_id != id {
                        log::info!("TCP ID change request: {} -> {} from {}", old_id, id, ip);

                        let result = if id.len() < 6 || id.len() > 16 {
                            log::warn!("Invalid ID format for change: {}", id);
                            register_pk_response::Result::UUID_MISMATCH
                        } else if !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                            log::warn!("Invalid ID characters for change: {}", id);
                            register_pk_response::Result::UUID_MISMATCH
                        } else if !id.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
                            log::warn!("ID must start with a letter: {}", id);
                            register_pk_response::Result::UUID_MISMATCH
                        } else {
                            self.pm.change_id(
                                old_id, id, addr, rk.uuid, rk.pk, ip
                            ).await
                        };

                        log::info!("TCP ID change result: {:?}", result);
                        let mut msg_out = RendezvousMessage::new();
                        msg_out.set_register_pk_response(RegisterPkResponse {
                            result: result.into(),
                            ..Default::default()
                        });
                        Self::send_to_sink(sink, msg_out).await;
                    } else {
                        log::info!("TCP RegisterPk: normal registration (not ID change), returning NOT_SUPPORT");
                        // Normal RegisterPk via TCP - not supported (use UDP)
                        let mut msg_out = RendezvousMessage::new();
                        msg_out.set_register_pk_response(RegisterPkResponse {
                            result: register_pk_response::Result::NOT_SUPPORT.into(),
                            ..Default::default()
                        });
                        Self::send_to_sink(sink, msg_out).await;
                    }
                }'''

if old_handler not in content:
    print('ERROR: Could not find TCP RegisterPk handler to replace!')
    print('Searching for partial match...')
    if 'return false;' in content and 'TCP ID change request' in content:
        print('Found partial - TCP handler exists but text mismatch')
    sys.exit(1)

new_content = content.replace(old_handler, new_handler)

with open(filepath, 'w') as f:
    f.write(new_content)

print(f'OK: TCP RegisterPk handler fixed ({len(content)} -> {len(new_content)} bytes)')
