/**
 * 备份仓库汇聚导出：import 本文件即注册全部仓库。
 */
import { registerBackupRepository } from "./base";
import { localRepository, nasRepository } from "./local";
import { alistRepository } from "./alist";

registerBackupRepository("local", localRepository);
registerBackupRepository("nas", nasRepository);
registerBackupRepository("alist", alistRepository);

export { listBackupRepositories, getBackupRepository } from "./base";
