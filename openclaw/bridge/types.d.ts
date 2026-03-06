declare module "unzipper" {
  import { Readable } from "node:stream";

  interface Directory {
    extract(opts: { path: string }): Promise<void>;
  }

  export const Open: {
    buffer(data: Buffer): Promise<Directory>;
  };
}
