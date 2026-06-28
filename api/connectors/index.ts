/**
 * 网盘连接器汇聚导出
 * 导入此文件即可注册所有连接器
 */
import { listConnectors, getConnector } from "./base";
import "./115";
import "./aliyundrive";
import "./nas";

export { listConnectors, getConnector };
export * from "./base";
