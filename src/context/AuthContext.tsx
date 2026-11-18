'use client';

import React, { createContext, useCallback, useContext, useState, useEffect } from 'react';
import { SessionUser } from '@/lib/types';
import {
  getCachedUser,
  reconcileSessionCheck,
  saveCachedUser,
} from '@/lib/authSession';
import {
  clearStandaloneLogin,
  readPendingStandaloneLogin,
} from '@/lib/pwaLogin';

interface AuthContextType {
  user: SessionUser | null;
  loading: boolean;
  authModalOpen: boolean;
  authModalTab: 'login' | 'register';
  openAuthModal: (tab?: 'login' | 'register') => void;
  closeAuthModal: () => void;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (email: string, password: string, username?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<'login' | 'register'>('login');

  const refreshUser = useCallback(async () => {
    const currentCached = getCachedUser();
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      let payload: { user?: unknown } | null = null;
      if (res.ok) {
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
      }

      const reconciled = reconcileSessionCheck({
        currentUser: currentCached,
        status: res.status,
        payload,
      });

      if (reconciled.shouldPersist && reconciled.user) {
        saveCachedUser(reconciled.user);
      } else if (reconciled.shouldClear) {
        saveCachedUser(null);
      }
      setUser(reconciled.user);
    } catch {
      const reconciled = reconcileSessionCheck({
        currentUser: currentCached,
        status: null,
        networkError: true,
      });
      setUser(reconciled.user);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Hydrate the last known authenticated session immediately so reopening
    // the PWA never flashes the guest login banner while /api/auth/me is in flight.
    const cached = getCachedUser();
    if (cached) {
      setUser(cached);
      setLoading(false);
    }
    refreshUser();
  }, [refreshUser]);

  // Standalone (home-screen PWA) Google login relay: iOS hands the Google
  // navigation to Safari and isolates the app's cookie jar from it, so the
  // callback hands the pre-signed session back through a one-time ticket.
  // Poll it here: this covers the app staying open behind Safari (regular
  // interval) and the app being suspended or killed (immediate check on
  // resume/startup, since the nonce survives in localStorage).
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const poll = async () => {
      if (cancelled) return;
      const pending = readPendingStandaloneLogin();
      if (!pending) {
        stop();
        return;
      }

      try {
        const res = await fetch(
          `/api/auth/login-status?ticket=${encodeURIComponent(pending.nonce)}`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => null)) as
          | { status?: string; user?: SessionUser }
          | null;

        if (cancelled) return;

        if (data?.status === 'ok' && data.user) {
          clearStandaloneLogin();
          saveCachedUser(data.user);
          setUser(data.user);
          setLoading(false);
          stop();
          return;
        }
        if (data?.status === 'expired' || data?.status === 'invalid') {
          clearStandaloneLogin();
          stop();
          return;
        }
      } catch {
        // Offline or transient failure: keep polling until the ticket TTL
        // expires, at which point readPendingStandaloneLogin() clears it.
      }

      if (!cancelled) timer = setTimeout(poll, 2500);
    };

    poll();

    // The user completed Google login in Safari and switched back: check the
    // ticket immediately instead of waiting for the next interval (which may
    // have been frozen while the app was suspended).
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        stop();
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const openAuthModal = (tab: 'login' | 'register' = 'login') => {
    setAuthModalTab(tab);
    setAuthModalOpen(true);
  };

  const closeAuthModal = () => {
    setAuthModalOpen(false);
  };

  const login = async (email: string, password: string) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || 'Failed to sign in' };
      }
      saveCachedUser(data.user);
      setUser(data.user);
      closeAuthModal();
      return { success: true };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const register = async (email: string, password: string, username?: string) => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, username }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || 'Failed to create account' };
      }
      saveCachedUser(data.user);
      setUser(data.user);
      closeAuthModal();
      return { success: true };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      saveCachedUser(null);
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        authModalOpen,
        authModalTab,
        openAuthModal,
        closeAuthModal,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
