import { useState, useEffect, useCallback } from 'react';

import type { ApiFetch } from '../types';

export type AuthStatus = 'loading' | 'setup_required' | 'login_required' | 'authenticated';

interface UseAuthOptions {
  apiFetch: ApiFetch;
  onAuthenticated: (username: string, manifestKey: string) => void;
  onUnauthenticated: () => void;
  onLogout: () => void;
}

export interface UseAuthReturn {
  authStatus: AuthStatus;
  manifestKey: string;
  authUsername: string;
  loginUsername: string;
  loginPassword: string;
  loginConfirmPassword: string;
  loginError: string;
  loginLoading: boolean;
  setAuthStatus: React.Dispatch<React.SetStateAction<AuthStatus>>;
  setLoginUsername: React.Dispatch<React.SetStateAction<string>>;
  setLoginPassword: React.Dispatch<React.SetStateAction<string>>;
  setLoginConfirmPassword: React.Dispatch<React.SetStateAction<string>>;
  handleSetup: (e: React.FormEvent) => Promise<void>;
  handleLogin: (e: React.FormEvent) => Promise<void>;
  handleLogout: () => void;
  handleAuthComplete: (token: string, username: string, key: string) => void;
  checkAuth: () => Promise<void>;
}

export function useAuth({
  apiFetch,
  onAuthenticated,
  onUnauthenticated,
  onLogout,
}: UseAuthOptions): UseAuthReturn {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [manifestKey, setManifestKey] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginConfirmPassword, setLoginConfirmPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const handleAuthComplete = useCallback((token: string, username: string, key: string) => {
    localStorage.setItem('auth_token', token);
    setAuthUsername(username);
    setManifestKey(key);
    setAuthStatus('authenticated');
    setLoginError('');
    setLoginUsername('');
    setLoginPassword('');
    setLoginConfirmPassword('');
    onAuthenticated(username, key);
  }, [onAuthenticated]);

  const handleSetup = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    if (loginPassword !== loginConfirmPassword) {
      setLoginError('Passwords do not match');
      return;
    }
    if (loginPassword.length < 4) {
      setLoginError('Password must be at least 4 characters');
      return;
    }
    if (!loginUsername.trim()) {
      setLoginError('Username is required');
      return;
    }
    setLoginLoading(true);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Setup failed');
        return;
      }
      handleAuthComplete(data.token, data.username, data.manifestKey);
    } catch {
      setLoginError('Connection failed');
    } finally {
      setLoginLoading(false);
    }
  }, [loginUsername, loginPassword, loginConfirmPassword, handleAuthComplete]);

  const handleLogin = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    if (!loginUsername.trim() || !loginPassword) {
      setLoginError('Username and password are required');
      return;
    }
    setLoginLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Login failed');
        return;
      }
      handleAuthComplete(data.token, data.username, data.manifestKey);
    } catch {
      setLoginError('Connection failed');
    } finally {
      setLoginLoading(false);
    }
  }, [loginUsername, loginPassword, handleAuthComplete]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('auth_token');
    setAuthStatus('login_required');
    setManifestKey('');
    setAuthUsername('');
    onLogout();
  }, [onLogout]);

  const checkAuth = useCallback(async () => {
    try {
      const response = await apiFetch('/api/auth/status');
      const data = await response.json();

      if (data.status === 'authenticated') {
        setAuthStatus('authenticated');
        setAuthUsername(data.username);
        setManifestKey(data.manifestKey);
        onAuthenticated(data.username, data.manifestKey);
      } else if (data.status === 'setup_required') {
        setAuthStatus('setup_required');
        onUnauthenticated();
      } else {
        localStorage.removeItem('auth_token');
        setAuthStatus('login_required');
        onUnauthenticated();
      }
    } catch {
      setAuthStatus('login_required');
      onUnauthenticated();
    }
  }, [apiFetch, onAuthenticated, onUnauthenticated]);

  // Auth check on mount — determines which screen to show
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return {
    authStatus,
    manifestKey,
    authUsername,
    loginUsername,
    loginPassword,
    loginConfirmPassword,
    loginError,
    loginLoading,
    setAuthStatus,
    setLoginUsername,
    setLoginPassword,
    setLoginConfirmPassword,
    handleSetup,
    handleLogin,
    handleLogout,
    handleAuthComplete,
    checkAuth,
  };
}
