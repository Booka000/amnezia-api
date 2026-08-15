import i18next from "i18next";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyCookie from "@fastify/cookie";
import metricsPlugin from "fastify-metrics";
import { appLogger } from "../winstonLogger";
import appConfig from "@/constants/appConfig";
import { AppContract } from "@/contracts/app";
import fastifyFormbody from "@fastify/formbody";
import { plugin } from "i18next-http-middleware";
import Fastify, { LogController } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { AppFastifyInstance } from "@/types/shared";
import { authPreHandler } from "@/middleware/auth";
import { setupAjvValidator } from "./setupAjvValidator";
import { setupFastifyRoutes } from "./setupFastifyRoutes";
import { getFastifyRoutes } from "@/helpers/getFastifyRoutes";
import { fastifyErrorHandler } from "@/helpers/fastifyErrorHandler";
import { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";

/**
 * Создать и настроить экземпляр Fastify без открытия сетевого порта
 */
export const createFastify = async (): Promise<AppFastifyInstance> => {
  const fastify: AppFastifyInstance = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
  })
    // Для улучшенной типизации запросов и ответов
    .withTypeProvider<JsonSchemaToTsProvider>();

  // Установить собственный обработчик ошибок
  fastify.setErrorHandler(fastifyErrorHandler);

  // Заголовки безопасности
  await fastify.register(fastifyHelmet);

  // Ограничение частоты запросов
  await fastify.register(fastifyRateLimit, {
    max: AppContract.RATE_LIMIT.MAX,
    timeWindow: AppContract.RATE_LIMIT.WINDOW_MS,
  });

  // Установить валидатор ошибок
  setupAjvValidator(fastify);

  // Интернационализация и локализация
  await fastify.register(plugin as never, { i18next });

  // Прочие плагины
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyFormbody);
  await fastify.register(metricsPlugin, { clearRegisterOnInit: true });
  await fastify.register(fastifyCors, {
    origin: appConfig.CORS_ORIGINS.length ? appConfig.CORS_ORIGINS : false,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key", "Accept-Language"],
    maxAge: 600,
    strictPreflight: true,
  });

  // Глобальная авторизация — без заголовка x-api-key недоступен ни один маршрут,
  // включая /healthz и /metrics. Браузеры получают 401 JSON, ничего не отдается.
  fastify.addHook("preHandler", authPreHandler());

  // Регистрация маршрутов
  setupFastifyRoutes(fastify);

  return fastify;
};

/**
 * Запустить Fastify API
 */
export const setupFastify = async (): Promise<AppFastifyInstance> => {
  const { host, port } = appConfig.FASTIFY_ROUTES;

  appLogger.info(`Запуск приложения Fastify...`);

  const fastify = await createFastify();

  await fastify.listen({ host, port });
  await fastify.ready();

  appLogger.verbose(`Приложение Fastify запущено на '${host}:${port}'`);

  appLogger.info(`Зарегистрированные маршруты:\n${getFastifyRoutes(fastify)}`);

  return fastify;
};
