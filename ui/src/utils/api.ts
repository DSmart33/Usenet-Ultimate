// What this does:
//   API fetch wrapper with JWT authentication and 401 auto-logout

export function createApiFetch(on401?: () => void) {
  return async (url: string, options?: RequestInit): Promise<Response> => {
    const token = localStorage.getItem('auth_token');
    const headers: Record<string, string> = {
      ...(options?.headers as Record<string, string> || {}),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      localStorage.removeItem('auth_token');
      on401?.();
      throw new Error('Session expired');
    }
    return response;
  };
}
