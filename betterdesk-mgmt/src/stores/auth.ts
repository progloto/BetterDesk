/**
 * Auth Store — manages operator authentication state
 *
 * Auth model: session cookies (express-session). No JWT tokens.
 * The browser automatically sends the `betterdesk.sid` cookie on each request.
 */
import { createSignal } from 'solid-js';
import {
    initApi, setServerUrl, getServerUrl,
    clearAuth, hasStoredAuth, login, verifyTotp, checkSession, logout
} from '../lib/api';

export interface User {
    username: string;
    role: string;
}

// ---- Signals ----
const [isLoggedIn, setIsLoggedIn] = createSignal(false);
const [user, setUser] = createSignal<User | null>(null);
const [isLoading, setIsLoading] = createSignal(true);

// ---- Exports ----
export { isLoggedIn, user, isLoading };

/** Initialize auth — check for existing session cookie */
export async function initAuth(): Promise<void> {
    initApi();
    setIsLoading(true);

    if (hasStoredAuth()) {
        try {
            const session = await checkSession();
            if (session.valid && session.user) {
                setUser(session.user);
                setIsLoggedIn(true);
            }
        } catch {
            // session invalid or server unreachable
        }
    }

    setIsLoading(false);
}

/** Login with credentials — sets session cookie, may require 2FA */
export async function doLogin(
    server: string,
    username: string,
    password: string
): Promise<{ success: boolean; totpRequired?: boolean; error?: string }> {
    try {
        setServerUrl(server);
        const result = await login(username, password);

        if (result.totpRequired) {
            // 2FA needed — session has pendingTotpUserId set server-side
            return { success: false, totpRequired: true };
        }

        if (result.success && result.user) {
            setUser(result.user);
            setIsLoggedIn(true);
            return { success: true };
        }

        return { success: false, error: result.error || 'Login failed' };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { success: false, error: msg };
    }
}

/** Complete 2FA verification — session already has pending user from login */
export async function doVerifyTotp(
    code: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const result = await verifyTotp(code);

        if (result.success && result.user) {
            setUser(result.user);
            setIsLoggedIn(true);
            return { success: true };
        }

        return { success: false, error: result.error || 'Verification failed' };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return { success: false, error: msg };
    }
}

/** Logout — destroy server session */
export async function doLogout(): Promise<void> {
    await logout();
    clearAuth();
    setUser(null);
    setIsLoggedIn(false);
}

/** Get stored server URL */
export function getStoredServer(): string {
    return getServerUrl();
}
