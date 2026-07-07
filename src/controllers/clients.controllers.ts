import {
  GetClientsType,
  GetClientQrType,
  CreateClientType,
  DeleteClientType,
  getClientsSchema,
  UpdateClientType,
  getClientQrSchema,
  createClientSchema,
  deleteClientSchema,
  updateClientSchema,
} from "@/schemas";
import {
  getClientsHandler,
  getClientQrHandler,
  createClientHandler,
  deleteClientHandler,
  updateClientHandler,
} from "@/handlers/clients";
import { AppFastifyRoute } from "@/types/shared";

/**
 * Получить всех клиентов
 */
export const getClientsController: AppFastifyRoute<GetClientsType> = {
  url: "/clients",
  method: "GET",
  schema: getClientsSchema,
  handler: getClientsHandler,
};

/**
 * Добавить клиента
 */
export const createClientController: AppFastifyRoute<CreateClientType> = {
  url: "/clients",
  method: "POST",
  schema: createClientSchema,
  handler: createClientHandler,
};

/**
 * Обновить данные клиента
 */
export const updateClientController: AppFastifyRoute<UpdateClientType> = {
  url: "/clients",
  method: "PATCH",
  schema: updateClientSchema,
  handler: updateClientHandler,
};

/**
 * Сгенерировать QR-коды для конфига клиента
 */
export const getClientQrController: AppFastifyRoute<GetClientQrType> = {
  url: "/clients/qr",
  method: "POST",
  schema: getClientQrSchema,
  handler: getClientQrHandler,
};

/**
 * Удалить клиента
 */
export const deleteClientController: AppFastifyRoute<DeleteClientType> = {
  url: "/clients",
  method: "DELETE",
  schema: deleteClientSchema,
  handler: deleteClientHandler,
};