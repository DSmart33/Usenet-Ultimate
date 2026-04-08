import { useState, useEffect, useCallback } from 'react';

import type { ApiFetch, Manifest } from '../types';

export type AuthStatus = 'loading' | 'setup_required' | 'login_required' | 'authenticated';

interface UseAuthOptions {
  apiFetch: ApiFetch;
  onAuthenticated: (username: string, manifests: Manifest[]) => void;
  onUnauthenticated: () => void;
  onLogout: () => void;
}

export interface UseAuthReturn {
  authStatus: AuthStatus;
  manifests: Manifest[];
  setManifests: React.Dispatch<React.SetStateAction<Manifest[]>>;
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
  checkAuth: () => Promise<void>;
}

export function useAuth({
  apiFetch,
  onAuthenticated,
  onUnauthenticated,
  onLogout,
}: UseAuthOptions): UseAuthReturn {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [authUsername, setAuthUsername] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginConfirmPassword, setLoginConfirmPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const handleAuthComplete = useCallback((token: string, username: string, deviceManifests: Manifest[]) => {
    localStorage.setItem('auth_token', token);
    setAuthUsername(username);
    setManifests(deviceManifests);
    setAuthStatus('authenticated');
    setLoginError('');
    setLoginUsername('');
    setLoginPassword('');
    setLoginConfirmPassword('');
    onAuthenticated(username, deviceManifests);
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
      handleAuthComplete(data.token, data.username, data.manifests || []);
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
      handleAuthComplete(data.token, data.username, data.manifests || []);
    } catch {
      setLoginError('Connection failed');
    } finally {
      setLoginLoading(false);
    }
  }, [loginUsername, loginPassword, handleAuthComplete]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('auth_token');
    setAuthStatus('login_required');
    setManifests([]);
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
        setManifests(data.manifests || []);
        onAuthenticated(data.username, data.manifests || []);
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
    manifests,
    setManifests,
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
    checkAuth,
  };
}
