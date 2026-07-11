import { authRouter } from "./auth-router";
import { agentRouter } from "./agent-router";
import { knowledgeRouter } from "./knowledge-router";
import { kbRouter } from "./kb-router";
import { workflowRouter } from "./workflow-router";
import { datasourceRouter } from "./datasource-router";
import { fileRouter } from "./file-router";
import { vectorRouter } from "./vector-router";
import { settingRouter } from "./setting-router";
import { backupRouter } from "./backup-router";
import { ingestionRouter } from "./ingestion-router";
import { connectorRouter } from "./connector-router";
import { zvecRouter } from "./zvec-router";
import { createRouter, publicQuery } from "./middleware";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  agent: agentRouter,
  knowledge: knowledgeRouter,
  kb: kbRouter,
  workflow: workflowRouter,
  datasource: datasourceRouter,
  file: fileRouter,
  vector: vectorRouter,
  setting: settingRouter,
  backup: backupRouter,
  ingestion: ingestionRouter,
  connector: connectorRouter,
});

export { zvecRouter };

export type AppRouter = typeof appRouter;
