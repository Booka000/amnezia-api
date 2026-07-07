import {
  GetServerType,
  getServerSchema,
  RebootServerType,
  GetServerLoadType,
  rebootServerSchema,
  GetServerBackupType,
  getServerLoadSchema,
  getServerBackupSchema,
  ImportServerBackupType,
  importServerBackupSchema,
} from "@/schemas";
import {
  getServerHandler,
  rebootServerHandler,
  getServerLoadHandler,
  getServerBackupHandler,
  importServerBackupHandler,
} from "@/handlers/server";
import { AppFastifyRoute } from "@/types/shared";

/**
 * Получить информацию о сервере
 */
export const getServerController: AppFastifyRoute<GetServerType> = {
  url: "/server",
  method: "GET",
  schema: getServerSchema,
  handler: getServerHandler,
};

/**
 * Получить метрики нагрузки сервера
 */
export const getServerLoadController: AppFastifyRoute<GetServerLoadType> = {
  url: "/server/load",
  method: "GET",
  schema: getServerLoadSchema,
  handler: getServerLoadHandler,
};

/**
 * Резервная копия конфигурации сервера
 */
export const getServerBackupController: AppFastifyRoute<GetServerBackupType> = {
  url: "/server/backup",
  method: "GET",
  schema: getServerBackupSchema,
  handler: getServerBackupHandler,
};

/**
 * Импорт резервной копии конфигурации сервера
 */
export const importServerBackupController: AppFastifyRoute<ImportServerBackupType> =
  {
    url: "/server/backup",
    method: "POST",
    schema: importServerBackupSchema,
    handler: importServerBackupHandler,
  };

/**
 * Перезагрузить сервер
 */
export const rebootServerController: AppFastifyRoute<RebootServerType> = {
  url: "/server/reboot",
  method: "POST",
  schema: rebootServerSchema,
  handler: rebootServerHandler,
};