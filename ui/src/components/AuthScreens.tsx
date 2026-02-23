import { Crown, User, Lock, XCircle } from 'lucide-react';
import type { AuthStatus } from '../hooks/useAuth';

interface AuthScreensProps {
  authStatus: AuthStatus;
  loginUsername: string;
  loginPassword: string;
  loginConfirmPassword: string;
  loginError: string;
  loginLoading: boolean;
  setLoginUsername: (value: string) => void;
  setLoginPassword: (value: string) => void;
  setLoginConfirmPassword: (value: string) => void;
  handleSetup: (e: React.FormEvent) => void;
  handleLogin: (e: React.FormEvent) => void;
  loading: boolean;
}

export default function AuthScreens({
  authStatus,
  loginUsername,
  loginPassword,
  loginConfirmPassword,
  loginError,
  loginLoading,
  setLoginUsername,
  setLoginPassword,
  setLoginConfirmPassword,
  handleSetup,
  handleLogin,
  loading,
}: AuthScreensProps) {
  // Auth loading screen
  if (authStatus === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <div className="animate-spin rounded-full h-12 w-12 border-2 border-amber-400 border-t-transparent"></div>
      </div>
    );
  }

  // Setup required screen
  if (authStatus === 'setup_required') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <div className="absolute inset-0" style={{
            backgroundImage: 'linear-gradient(rgba(245, 158, 11, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(245, 158, 11, 0.08) 1px, transparent 1px)',
            backgroundSize: '50px 50px'
          }} />
        </div>
        <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/8 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-yellow-500/8 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />

        <div className="relative z-10 w-full max-w-md mx-4">
          <div className="bg-gradient-to-br from-slate-900 via-slate-800/95 to-slate-900 rounded-xl border border-amber-500/20 shadow-2xl shadow-amber-500/5 p-8 animate-fade-in-up">
            <div className="flex flex-col items-center gap-4 mb-8">
              <div className="relative group">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500 to-yellow-600 rounded-2xl blur-xl opacity-40 animate-pulse-glow" />
                <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/25">
                  <Crown className="w-8 h-8 text-white" />
                </div>
              </div>
              <div className="text-center">
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">
                  Usenet Ultimate
                </h1>
                <p className="text-slate-400 text-sm mt-1">Create your account to get started</p>
              </div>
            </div>

            <form onSubmit={handleSetup} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Username</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    className="input pl-10 w-full"
                    placeholder="Choose a username"
                    autoFocus
                    autoComplete="username"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    className="input pl-10 w-full"
                    placeholder="Choose a password"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="password"
                    value={loginConfirmPassword}
                    onChange={(e) => setLoginConfirmPassword(e.target.value)}
                    className="input pl-10 w-full"
                    placeholder="Confirm your password"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              {loginError && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-500/20 border border-red-500/50 rounded-lg">
                  <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <span className="text-sm text-red-400">{loginError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 text-white rounded-lg transition-all shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 disabled:opacity-50"
              >
                {loginLoading ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                ) : (
                  <>
                    <Crown className="w-4 h-4" />
                    Create Account
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Login required screen
  if (authStatus === 'login_required') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <div className="absolute inset-0" style={{
            backgroundImage: 'linear-gradient(rgba(245, 158, 11, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(245, 158, 11, 0.08) 1px, transparent 1px)',
            backgroundSize: '50px 50px'
          }} />
        </div>
        <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/8 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 left-0 w-96 h-96 bg-yellow-500/8 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />

        <div className="relative z-10 w-full max-w-md mx-4">
          <div className="bg-gradient-to-br from-slate-900 via-slate-800/95 to-slate-900 rounded-xl border border-amber-500/20 shadow-2xl shadow-amber-500/5 p-8 animate-fade-in-up">
            <div className="flex flex-col items-center gap-4 mb-8">
              <div className="relative group">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500 to-yellow-600 rounded-2xl blur-xl opacity-40 animate-pulse-glow" />
                <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/25">
                  <Crown className="w-8 h-8 text-white" />
                </div>
              </div>
              <div className="text-center">
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">
                  Usenet Ultimate
                </h1>
                <p className="text-slate-400 text-sm mt-1">Sign in to continue</p>
              </div>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Username</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="text"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    className="input pl-10 w-full"
                    placeholder="Username"
                    autoFocus
                    autoComplete="username"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    className="input pl-10 w-full"
                    placeholder="Password"
                    autoComplete="current-password"
                  />
                </div>
              </div>

              {loginError && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-500/20 border border-red-500/50 rounded-lg">
                  <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <span className="text-sm text-red-400">{loginError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 text-white rounded-lg transition-all shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 disabled:opacity-50"
              >
                {loginLoading ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                ) : (
                  <>
                    <Crown className="w-4 h-4" />
                    Sign In
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Main app loading state (after auth is complete)
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  // Authenticated and loaded - return null so the main app renders
  return null;
}
