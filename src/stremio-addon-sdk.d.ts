declare module 'stremio-addon-sdk' {
  interface Manifest {
    id: string;
    version: string;
    name: string;
    description: string;
    resources: string[];
    types: string[];
    catalogs: any[];
    idPrefixes?: string[];
    behaviorHints?: Record<string, any>;
  }

  interface StreamRequest {
    type: string;
    id: string;
  }

  interface AddonBuilder {
    defineStreamHandler(handler: (args: StreamRequest) => Promise<{ streams: any[] }>): void;
    getInterface(): any;
  }

  export function addonBuilder(manifest: Manifest): AddonBuilder;
  export function getRouter(addonInterface: any): any;

  const sdk: {
    addonBuilder: typeof addonBuilder;
    getRouter: typeof getRouter;
  };
  export default sdk;
}
