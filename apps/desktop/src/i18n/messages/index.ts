import { app } from "./app.js";
import { common } from "./common.js";
import { docs } from "./docs.js";
import { service } from "./service.js";
import { session } from "./session.js";
import { toolSteps } from "./tool-steps.js";
import { work } from "./work.js";

/** All messages by language; each area prefixes its keys so they stay unique. */
export const catalog = {
  zh: { ...common.zh, ...toolSteps.zh, ...app.zh, ...work.zh, ...docs.zh, ...session.zh, ...service.zh },
  en: { ...common.en, ...toolSteps.en, ...app.en, ...work.en, ...docs.en, ...session.en, ...service.en }
};
