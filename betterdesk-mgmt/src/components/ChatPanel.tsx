/**
 * ChatPanel — operator chat with device users
 *
 * Connects to chat relay WebSocket for real-time messaging.
 * Shows contact list on the left, conversation on the right.
 */
import { createSignal, onMount, onCleanup, Show, For } from 'solid-js';
import { t } from '../lib/i18n';
import { getDevices, type Device } from '../lib/api';
import { toastError } from '../stores/toast';
import { user } from '../stores/auth';

interface ChatMessage {
    id: string;
    from: string;
    text: string;
    timestamp: number;
    sent: boolean;
}

interface Contact {
    id: string;
    name: string;
    online: boolean;
    lastMessage?: string;
}

export default function ChatPanel() {
    const [contacts, setContacts] = createSignal<Contact[]>([]);
    const [activeContact, setActiveContact] = createSignal<string | null>(null);
    const [messages, setMessages] = createSignal<ChatMessage[]>([]);
    const [messageText, setMessageText] = createSignal('');
    const [loading, setLoading] = createSignal(true);
    const [wsConnected, setWsConnected] = createSignal(false);
    let ws: WebSocket | null = null;
    let messagesEndRef: HTMLDivElement | undefined;

    onMount(async () => {
        await loadContacts();
        connectWS();
    });

    onCleanup(() => {
        if (ws) {
            ws.close();
            ws = null;
        }
    });

    async function loadContacts() {
        setLoading(true);
        try {
            const devices = await getDevices();
            const contactList: Contact[] = devices
                .filter(d => d.online || d.status === 'online')
                .map(d => ({
                    id: d.id,
                    name: d.hostname || d.id,
                    online: d.online || d.status === 'online',
                }));
            setContacts(contactList);
        } catch {
            toastError(t('common.error'), t('chat.load_error'));
        } finally {
            setLoading(false);
        }
    }

    function connectWS() {
        const serverUrl = localStorage.getItem('bd_mgmt_server_url') || '';
        if (!serverUrl) return;

        const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/chat';
        try {
            ws = new WebSocket(wsUrl);
            ws.onopen = () => {
                setWsConnected(true);
                // Send auth
                ws?.send(JSON.stringify({
                    type: 'auth',
                    operator: user()?.username || 'operator',
                }));
            };
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'message') {
                        const msg: ChatMessage = {
                            id: `${Date.now()}-${Math.random()}`,
                            from: data.from,
                            text: data.text,
                            timestamp: data.timestamp || Date.now(),
                            sent: false,
                        };
                        setMessages(prev => [...prev, msg]);
                        scrollToBottom();
                    }
                } catch {
                    // ignore malformed messages
                }
            };
            ws.onclose = () => setWsConnected(false);
            ws.onerror = () => setWsConnected(false);
        } catch {
            setWsConnected(false);
        }
    }

    function scrollToBottom() {
        setTimeout(() => messagesEndRef?.scrollIntoView({ behavior: 'smooth' }), 50);
    }

    function sendMessage() {
        const text = messageText().trim();
        const contact = activeContact();
        if (!text || !contact || !ws || ws.readyState !== WebSocket.OPEN) return;

        ws.send(JSON.stringify({
            type: 'message',
            to: contact,
            text,
        }));

        const msg: ChatMessage = {
            id: `${Date.now()}-${Math.random()}`,
            from: 'me',
            text,
            timestamp: Date.now(),
            sent: true,
        };
        setMessages(prev => [...prev, msg]);
        setMessageText('');
        scrollToBottom();
    }

    function formatTime(ts: number): string {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    return (
        <div class="chat-panel page-enter">
            {/* Contact List */}
            <div class="chat-sidebar">
                <div class="chat-sidebar-header">
                    <span class="material-symbols-rounded" style="font-size: 18px;">chat</span>
                    <span>{t('chat.title')}</span>
                    <span class={`status-dot ${wsConnected() ? 'online' : 'offline'}`} style="margin-left: auto;" />
                </div>
                <div class="chat-contact-list">
                    <Show when={!loading()} fallback={<div class="loading-center"><div class="spinner" /></div>}>
                        <Show when={contacts().length > 0} fallback={
                            <div class="empty-state" style="padding: 24px;">
                                <span class="material-symbols-rounded" style="font-size: 32px;">devices_off</span>
                                <div class="empty-state-text">{t('chat.no_contacts')}</div>
                            </div>
                        }>
                            <For each={contacts()}>
                                {(contact) => (
                                    <button
                                        class={`chat-contact ${activeContact() === contact.id ? 'active' : ''}`}
                                        onClick={() => { setActiveContact(contact.id); setMessages([]); }}
                                    >
                                        <div class="chat-contact-avatar">
                                            {contact.name.charAt(0).toUpperCase()}
                                        </div>
                                        <div class="chat-contact-info">
                                            <div class="chat-contact-name">{contact.name}</div>
                                            <div class="chat-contact-id">{contact.id}</div>
                                        </div>
                                        <span class={`status-dot ${contact.online ? 'online' : 'offline'}`} />
                                    </button>
                                )}
                            </For>
                        </Show>
                    </Show>
                </div>
            </div>

            {/* Conversation */}
            <div class="chat-main">
                <Show when={activeContact()} fallback={
                    <div class="empty-state" style="flex: 1;">
                        <span class="material-symbols-rounded">forum</span>
                        <div class="empty-state-text">{t('chat.select_contact')}</div>
                    </div>
                }>
                    <div class="chat-messages">
                        <For each={messages()}>
                            {(msg) => (
                                <div class={`chat-message ${msg.sent ? 'sent' : 'received'}`}>
                                    <div class="chat-bubble">
                                        <div class="chat-text">{msg.text}</div>
                                        <div class="chat-time">{formatTime(msg.timestamp)}</div>
                                    </div>
                                </div>
                            )}
                        </For>
                        <div ref={messagesEndRef} />
                    </div>
                    <div class="chat-input-bar">
                        <input
                            type="text"
                            class="form-input"
                            placeholder={t('chat.type_message')}
                            value={messageText()}
                            onInput={(e) => setMessageText(e.currentTarget.value)}
                            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                            style="flex: 1;"
                        />
                        <button class="btn-primary" style="width: auto; padding: 8px 16px;" onClick={sendMessage}>
                            <span class="material-symbols-rounded" style="font-size: 18px;">send</span>
                        </button>
                    </div>
                </Show>
            </div>
        </div>
    );
}
