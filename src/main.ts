import { loadConfig } from "./infrastructure/config/app-config";
import { createApp } from "./interface/http/create-app";

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.httpPort);
