'use client';

import React, { createContext, useCallback, useContext, useState, useEffect } from 'react';
import { SessionUser } from '@/lib/types';
import {
  getCachedUser,
  reconcileSessionCheck,
  saveCachedUser,
} from '@/lib/authSession';

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
