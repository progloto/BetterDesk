/**
 * Settings — language, theme, server connection
 */
import { createSignal } from 'solid-js';
import { t, getLocale, setLocale, SUPPORTED_LOCALES } from '../lib/i18n';
import { getServerUrl, setServerUrl } from '../lib/api';

export default function Settings() {
    const [serverAddr, setServerAddr] = createSignal(getServerUrl());
    const [selectedLocale, setSelectedLocale] = createSignal(getLocale());
    const [saved, setSaved] = createSignal(false);

    async function handleLocaleChange(code: string) {
        setSelectedLocale(code);
        await setLocale(code);
    }

    function handleSave() {
        setServerUrl(serverAddr());
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    }

    return (
        <div class="page-enter" style="max-width: 500px;">
            {/* Language */}
            <div class="section-title">{t('settings.language')}</div>
            <div style="margin-bottom: 24px;">
                <select
                    class="form-input"
                    value={selectedLocale()}
                    onChange={(e) => handleLocaleChange(e.currentTarget.value)}
                    style="width: 100%;"
                >
                    {SUPPORTED_LOCALES.map(loc => (
                        <option value={loc.code}>{loc.flag} {loc.name}</option>
                    ))}
                </select>
            </div>

            {/* Server */}
            <div class="section-title">{t('settings.server')}</div>
            <div class="form-group" style="margin-bottom: 16px;">
                <label class="form-label">{t('settings.server_address')}</label>
                <input
                    type="url"
                    class="form-input"
                    value={serverAddr()}
                    onInput={(e) => setServerAddr(e.currentTarget.value)}
                />
            </div>
            <button class="btn-primary" onClick={handleSave} style="width: auto; padding: 8px 24px;">
                {saved() ? t('settings.saved') : t('settings.save')}
            </button>
        </div>
    );
}
