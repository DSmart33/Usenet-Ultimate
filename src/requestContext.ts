import { AsyncLocalStorage } from 'async_hooks';

export const requestContext = new AsyncLocalStorage<{ manifestKey: string; baseUrl: string; pathPrefix: string }>();
