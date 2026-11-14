import {
  ClientPeer,
  PeerStatus,
  ClientRecord,
  CreateClientResult,
} from "@/types/clients";
import {
  AwgVersion,
  ClientTableEntry,
  IAmneziaConnection,
} from "@/types/amnezia";
import {
  parseAwgParams,
  resolveAwgVersion,
  dropEmptyConfigLines,
  AWG_SPECIAL_JUNK_KEYS,
} from "@/helpers/awgConfig";
import { APIError } from "@/utils/APIError";
import appConfig from "@/constants/appConfig";
import { appLogger } from "@/config/winstonLogger";
import { AppContract } from "@/contracts/app";
import { AmneziaBackupData } from "@/types/server";
import { Protocol, ClientErrorCode } from "@/types/shared";
import { encodeVpnConfig } from "@/helpers/encodeVpnConfig";

/**
 * Сервис для работы с AmneziaWG 3.1
 * Контейнер amnezia-awg2 может остаться на 2.0,
 * тогда клиентский конфиг собирается по параметрам 2.0
 */
export class AmneziaWg3Service {
  static key = "amneziaWg3Service";

  // Шаблон клиентского конфига AmneziaWG 3.1
  private static readonly AMNEZIAWG3_CLIENT_TEMPLATE =
    `[Interface]\n` +
    `Address = $CLIENT_ADDRESS/32\n` +
    `DNS = $PRIMARY_DNS, $SECONDARY_DNS\n` +
    `PrivateKey = $CLIENT_PRIVATE_KEY\n` +
    `Jc = $JC\n` +
    `Jmin = $JMIN\n` +
    `Jmax = $JMAX\n` +
    `S1 = $S1\n` +
    `S2 = $S2\n` +
    `S3 = $S3\n` +
    `S4 = $S4\n` +
    `H1 = $H1\n` +
    `H2 = $H2\n` +
    `H3 = $H3\n` +
    `H4 = $H4\n` +
    `I1 = $I1\n` +
    `I2 = $I2\n` +
    `I3 = $I3\n` +
    `I4 = $I4\n` +
    `I5 = $I5\n` +
    `HeaderProtectionKey = $HEADER_PROTECTION_KEY\n` +
    `ContentPaddingAddition = $CONTENT_PADDING_ADDITION\n` +
    `RekeyAfterTime = $REKEY_AFTER_TIME\n` +
    `RekeyTimeout = $REKEY_TIMEOUT\n` +
    `RejectAfterTime = $REJECT_AFTER_TIME\n` +
    `KeepaliveTimeout = $KEEPALIVE_TIMEOUT\n` +
    `MaxHandshakeAttempts = $MAX_HANDSHAKE_ATTEMPTS\n` +
    `RandomTrailers = $RANDOM_TRAILERS\n` +
    `DisableCookies = $DISABLE_COOKIES\n\n` +
    `[Peer]\n` +
    `PublicKey = $SERVER_PUBLIC_KEY\n` +
    `PresharedKey = $PRESHARED_KEY\n` +
    `AllowedIPs = 0.0.0.0/0\n` +
    `$ENDPOINT_LINE` +
    `PersistentKeepalive = $PERSISTENT_KEEPALIVE\n`;

  // Плейсхолдеры параметров AmneziaWG в шаблоне
  private static readonly PARAM_PLACEHOLDERS: Record<string, string> = {
    Jc: "$JC",
    Jmin: "$JMIN",
    Jmax: "$JMAX",
    S1: "$S1",
    S2: "$S2",
    S3: "$S3",
    S4: "$S4",
    H1: "$H1",
    H2: "$H2",
    H3: "$H3",
    H4: "$H4",
    I1: "$I1",
    I2: "$I2",
    I3: "$I3",
    I4: "$I4",
    I5: "$I5",
    HeaderProtectionKey: "$HEADER_PROTECTION_KEY",
    ContentPaddingAddition: "$CONTENT_PADDING_ADDITION",
    RekeyAfterTime: "$REKEY_AFTER_TIME",
    RekeyTimeout: "$REKEY_TIMEOUT",
    RejectAfterTime: "$REJECT_AFTER_TIME",
    KeepaliveTimeout: "$KEEPALIVE_TIMEOUT",
    MaxHandshakeAttempts: "$MAX_HANDSHAKE_ATTEMPTS",
    RandomTrailers: "$RANDOM_TRAILERS",
    DisableCookies: "$DISABLE_COOKIES",
  };

  constructor(private amneziaWg3: IAmneziaConnection) {}

  /**
   * Проверить, что секция [Peer] принадлежит клиенту с данным publicKey
   */
  private isPeerSection(section: string, clientId: string): boolean {
    return section.match(/PublicKey\s*=\s*([^\s]+)/i)?.[1] === clientId;
  }

  /**
   * Получить AllowedIPs для peer'а
   */
  private getPeerAllowedIps(config: string, clientId: string): string | null {
    const sections = config.split("[Peer]");

    for (const section of sections) {
      if (!this.isPeerSection(section, clientId)) {
        continue;
      }

      const match = section.match(/AllowedIPs\s*=\s*([^\n]+)/i);
      return match?.[1]?.trim() || null;
    }

    return null;
  }

  /**
   * Обновить AllowedIPs для peer'а
   */
  private updatePeerAllowedIps(
    config: string,
    clientId: string,
    allowedIps: string,
  ): string {
    const sections = config.split("[Peer]");
    let changed = false;

    const updatedSections = sections.map((section) => {
      if (!this.isPeerSection(section, clientId)) {
        return section;
      }

      changed = true;

      if (/AllowedIPs\s*=/i.test(section)) {
        return section.replace(
          /AllowedIPs\s*=\s*([^\n]+)/i,
          `AllowedIPs = ${allowedIps}`,
        );
      }

      return section.replace(
        /PublicKey\s*=\s*([^\n]+)/i,
        (line) => `${line}\nAllowedIPs = ${allowedIps}`,
      );
    });

    return changed ? updatedSections.join("[Peer]") : config;
  }

  /**
   * Определить валидный IPv4-адрес peer'а: сначала AllowedIPs из конфига, затем userData.allowedIp
   */
  private resolvePeerIp(
    currentAllowedIps: string | null,
    userData: ClientTableEntry["userData"],
  ): string | null {
    const candidates = [
      currentAllowedIps?.split(",")[0]?.trim(),
      userData?.allowedIp,
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;

      const ip = candidate.includes("/")
        ? candidate.split("/")[0]
        : candidate;

      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip !== "0.0.0.0") {
        return ip;
      }
    }

    return null;
  }

  /**
   * Проверить, что AllowedIPs peer'а — это только 0.0.0.0/32 (блокировка старым способом)
   */
  private isLegacyBlockedIp(currentAllowedIps: string | null): boolean {
    return currentAllowedIps?.trim() === "0.0.0.0/32";
  }

  /**
   * Экспортировать данные AmneziaWG 3.1 для резервной копии
   */
  async exportBackup(): Promise<AmneziaBackupData> {
    const [wgConfig, clients, serverPublicKeyRaw, presharedKeyRaw] =
      await Promise.all([
        this.amneziaWg3.readWgConfig(),
        this.amneziaWg3.readClientsTable(),
        this.amneziaWg3.readFile(
          AppContract.AmneziaWG3.PATHS.SERVER_PUBLIC_KEY,
        ),
        this.amneziaWg3.readFile(AppContract.AmneziaWG3.PATHS.WG_PSK),
      ]);

    return {
      wgConfig,
      clients,
      serverPublicKey: serverPublicKeyRaw.trim(),
      presharedKey: presharedKeyRaw.trim(),
    };
  }

  /**
   * Импортировать данные AmneziaWG 3.1 из резервной копии
   */
  async importBackup(data: AmneziaBackupData): Promise<void> {
    await this.amneziaWg3.writeWgConfig(data.wgConfig);
    await this.amneziaWg3.writeClientsTable(data.clients);
    await this.amneziaWg3.writeFile(
      AppContract.AmneziaWG3.PATHS.WG_PSK,
      `${data.presharedKey.trim()}\n`,
    );
    await this.amneziaWg3.writeFile(
      AppContract.AmneziaWG3.PATHS.SERVER_PUBLIC_KEY,
      `${data.serverPublicKey.trim()}\n`,
    );
    await this.amneziaWg3.syncWgConfig();
  }

  /**
   * Разобрать [Peer] секции из wg0.conf — источник истины для списка peer'ов и AllowedIPs
   */
  private parseConfigPeers(
    config: string,
  ): { id: string; allowedIps: string[] }[] {
    if (!config) return [];

    const sections = config.split("[Peer]").slice(1);

    const peers: { id: string; allowedIps: string[] }[] = [];

    for (const section of sections) {
      const id = section.match(/PublicKey\s*=\s*([^\s]+)/i)?.[1];
      if (!id) continue;

      const allowedIps = section
        .match(/AllowedIPs\s*=\s*([^\n]+)/i)?.[1]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];

      peers.push({ id, allowedIps });
    }

    return peers;
  }

  /**
   * Разобрать awg show dump — только runtime статистика (endpoint/lastHandshake/traffic)
   */
  private parseDumpStats(
    dump: string,
  ): Map<
    string,
    { endpoint: string | null; lastHandshake: number; received: number; sent: number }
  > {
    const stats = new Map<
      string,
      { endpoint: string | null; lastHandshake: number; received: number; sent: number }
    >();

    if (!dump) return stats;

    for (const rawLine of dump.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const parts = line.split("\t");
      if (parts.length < 8) continue;

      const id = parts[0];
      if (!id) continue;

      const endpoint = parts[2] && parts[2] !== "(none)" ? parts[2] : null;

      const rawHandshake = Number(parts[4]);
      const lastHandshake =
        rawHandshake > AppContract.WG.HANDSHAKE_NANO_THRESHOLD
          ? Math.floor(rawHandshake / 1_000_000_000)
          : rawHandshake;

      stats.set(id, {
        endpoint,
        lastHandshake,
        received: Number(parts[5]) || 0,
        sent: Number(parts[6]) || 0,
      });
    }

    return stats;
  }

  /**
   * Получить список клиентов: wg0.conf — источник истины, dump — только runtime статистика
   */
  async getClients(): Promise<ClientRecord[]> {
    const now = Math.floor(Date.now() / 1000);

    const [config, dump, clientsTable] = await Promise.all([
      this.amneziaWg3.readWgConfig(),
      this.amneziaWg3.getWgDump(),
      this.amneziaWg3.readClientsTable(),
    ]);

    const configPeers = this.parseConfigPeers(config);
    const dumpStats = this.parseDumpStats(dump);

    const userData: Record<
      string,
      { name: string; peerNames: string[]; expiresAt?: number }
    > = {};

    for (const client of clientsTable) {
      const clientKey = client?.clientId;
      const clientName = client?.userData?.clientName;
      const expiresAt = client.userData?.expiresAt;

      if (!clientKey || !clientName) continue;

      const nameMatch = clientName.match(/^\s*(.*?)\s*(?:\[(.*)\])?\s*$/);
      const userName = (nameMatch?.[1] || clientName).trim();
      const peerName = (nameMatch?.[2] || "").trim();

      if (!userData[clientKey]) {
        userData[clientKey] = {
          name: userName,
          peerNames: [],
          expiresAt,
        };
      }

      if (peerName && !userData[clientKey].peerNames.includes(peerName)) {
        userData[clientKey].peerNames.push(peerName);
      }

      if (expiresAt) {
        userData[clientKey].expiresAt = expiresAt;
      }
    }

    const disabledPeerIds = new Set<string>();
    for (const client of clientsTable) {
      if (
        client?.clientId &&
        client.userData?.status === PeerStatus.Disabled
      ) {
        disabledPeerIds.add(client.clientId);
      }
    }

    const peerEntries: (ClientPeer & { username: string })[] = configPeers.map(
      ({ id, allowedIps }) => {
        const runtime = dumpStats.get(id);
        const lastHandshake = runtime?.lastHandshake ?? 0;
        const lastHandshakeSecondsAgo = now - lastHandshake;
        const online =
          lastHandshakeSecondsAgo < AppContract.WG.ONLINE_THRESHOLD_SECONDS;

        const username = userData[id]?.name || id;
        const name = userData[id]?.peerNames?.[0] ?? null;
        const expiresAt = userData[id]?.expiresAt || null;
        const isBlocked =
          allowedIps.length === 1 && allowedIps[0] === "0.0.0.0/32";
        const status =
          disabledPeerIds.has(id) || isBlocked
            ? PeerStatus.Disabled
            : PeerStatus.Active;

        return {
          username,
          id,
          name,
          allowedIps,
          lastHandshake,
          traffic: {
            received: runtime?.received ?? 0,
            sent: runtime?.sent ?? 0,
          },
          endpoint: runtime?.endpoint ?? null,
          online,
          expiresAt,
          status,
          protocol: Protocol.AMNEZIAWG3,
        };
      },
    );

    const users = new Map<string, ClientRecord>();
    for (const { username, ...peer } of peerEntries) {
      const entry = users.get(username) || {
        username,
        peers: [],
      };

      entry.peers.push(peer);
      users.set(username, entry);
    }

    return Array.from(users.values());
  }

  /**
   * Создать нового клиента
   */
  async createClient(
    clientName: string,
    options?: { expiresAt?: number | null },
  ): Promise<CreateClientResult> {
    // Проверка лимита максимального числа peer'ов
    const maxPeers = appConfig.SERVER_MAX_PEERS;
    if (maxPeers) {
      const clients = await this.getClients();

      const currentPeers = clients.reduce(
        (acc, client) => acc + client.peers.length,
        0,
      );

      if (currentPeers >= maxPeers) {
        throw new APIError(ClientErrorCode.CONFLICT);
      }
    }

    // Сгенерировать приватный ключ
    const clientPrivateKey = (
      await this.amneziaWg3.run(`awg genkey`)
    ).stdout.trim();

    // Сгенерировать публичный ключ
    const clientId = (
      await this.amneziaWg3.run(`echo '${clientPrivateKey}' | awg pubkey`)
    ).stdout.trim();

    // Считать конфиг
    const config = await this.amneziaWg3.readWgConfig();

    // Выбор свободного IP
    const assignedIp = (() => {
      const used = new Set<number>();

      // Префикс
      const prefix =
        /Address\s*=\s*([0-9]+\.[0-9]+\.[0-9]+)\.\d+/i.exec(config)?.[1] ||
        "10.8.1";

      // Получаем используемые IP
      const matches = config.matchAll(
        /AllowedIPs\s*=\s*[0-9]+\.[0-9]+\.[0-9]+\.([0-9]+)\s*\/32/gi,
      );

      for (const match of matches) {
        used.add(Number(match[1]));
      }

      // Находим первый свободный IP
      for (let host = 1; host <= 254; host++) {
        if (!used.has(host)) {
          return `${prefix}.${host}`;
        }
      }

      throw new APIError(ClientErrorCode.CONFLICT, {
        msg: "swagger.errors.NO_FREE_IP",
      });
    })();

    // Считать PSK
    const psk = (
      await this.amneziaWg3.run(
        `cat ${AppContract.AmneziaWG3.PATHS.WG_PSK} 2>/dev/null || true`,
      )
    ).stdout.trim();

    // Добавляем peer в конфиг
    const peerPskLine = `PresharedKey = ${psk}\n`;
    const peerSection = `\n[Peer]\nPublicKey = ${clientId}\n${peerPskLine}AllowedIPs = ${assignedIp}/32\n`;

    // Собираем новый конфиг
    const newConfig =
      (config.endsWith("\n") ? config : config + "\n") + peerSection;

    await this.amneziaWg3.writeWgConfig(newConfig);
    await this.amneziaWg3.syncWgConfig();

    // Добавляем клиента в clientsTable
    const table = await this.amneziaWg3.readClientsTable();

    // Добавляем дату создания
    const creationDate = new Date().toString();

    // Добавляем клиента в clientsTable
    const userData: ClientTableEntry["userData"] = {
      clientName,
      creationDate,
      allowedIp: assignedIp,
    };

    if (options?.expiresAt) {
      userData.expiresAt = options.expiresAt;
    }

    table.push({ clientId, userData });
    await this.amneziaWg3.writeClientsTable(table);

    // Получаем публичный ключ сервера
    const serverPublicKey = (
      await this.amneziaWg3.run(
        `cat ${AppContract.AmneziaWG3.PATHS.SERVER_PUBLIC_KEY} 2>/dev/null || true`,
      )
    ).stdout.trim();

    // Получаем порт
    const listenPort =
      config.match(/\[Interface\][\s\S]*?ListenPort\s*=\s*(\d+)/i)?.[1] || "";

    // Получаем хост
    const endpointHost = appConfig.SERVER_PUBLIC_HOST || "";

    // Получаем MTU
    const mtu = AppContract.AmneziaWG3.DEFAULTS.MTU;

    // Параметры AWG из серверного конфига
    const awgParams = parseAwgParams(config);

    // Версию задает набор параметров: 3.1 добавляет защиту заголовков,
    // рандомизацию таймингов и трейлеры
    const isV3 = resolveAwgVersion(awgParams) === AwgVersion.V3_1;

    // Дефолты нужны только для 2.0: в 3.1 набор параметров задает сервер,
    // и лишние значения сломают рукопожатие
    if (!isV3) {
      for (const [key, value] of Object.entries(
        AppContract.AmneziaWG3.PARAM_DEFAULTS,
      )) {
        awgParams[key] ||= value;
      }
    }

    // В 3.1 PersistentKeepalive задается диапазоном
    const keepAlive = isV3
      ? AppContract.AmneziaWG3.DEFAULTS.KEEPALIVE_V3
      : AppContract.AmneziaWG3.DEFAULTS.KEEPALIVE;

    const primaryDns = AppContract.DNS.PRIMARY;
    const secondaryDns = AppContract.DNS.SECONDARY;

    // Текстовый конфиг
    let configText = AmneziaWg3Service.AMNEZIAWG3_CLIENT_TEMPLATE.replace(
      /\$CLIENT_ADDRESS/g,
      assignedIp,
    )
      .replace(/\$PRIMARY_DNS/g, primaryDns)
      .replace(/\$SECONDARY_DNS/g, secondaryDns)
      .replace(/\$CLIENT_PRIVATE_KEY/g, clientPrivateKey)
      .replace(/\$SERVER_PUBLIC_KEY/g, serverPublicKey)
      .replace(/\$PRESHARED_KEY/g, psk)
      .replace(
        /\$ENDPOINT_LINE/g,
        endpointHost && listenPort
          ? `Endpoint = ${endpointHost}:${listenPort}\n`
          : "",
      )
      .replace(/\$PERSISTENT_KEEPALIVE/g, String(keepAlive));

    // Подставляем параметры AWG
    for (const [key, placeholder] of Object.entries(
      AmneziaWg3Service.PARAM_PLACEHOLDERS,
    )) {
      configText = configText.replaceAll(placeholder, () => awgParams[key]);
    }

    configText = dropEmptyConfigLines(configText);

    // Параметры для JSON: клиент Amnezia хранит пустые I1–I5
    // и опускает остальные незаданные параметры
    const jsonParams = Object.fromEntries(
      Object.keys(AmneziaWg3Service.PARAM_PLACEHOLDERS)
        .filter((key) => awgParams[key] || AWG_SPECIAL_JUNK_KEYS.includes(key))
        .map((key) => [key, awgParams[key]]),
    );

    // Последний конфиг
    const lastConfig = {
      ...jsonParams,
      allowed_ips: ["0.0.0.0/0", "::/0"],
      clientId: clientId,
      client_ip: `${assignedIp}`,
      client_priv_key: clientPrivateKey,
      client_pub_key: clientId,
      config: configText,
      hostName: endpointHost,
      mtu,
      persistent_keep_alive: keepAlive,
      port: listenPort ? Number(listenPort) : undefined,
      psk_key: psk,
      server_pub_key: serverPublicKey,
    } as Record<string, unknown>;

    // AWG
    const awg = {
      ...jsonParams,
      protocol_version: isV3 ? AwgVersion.V3_1 : AwgVersion.V2,
      last_config: JSON.stringify(lastConfig, null, 2),
      port: String(listenPort || ""),
      transport_proto: AppContract.AmneziaWG3.DEFAULTS.TRANSPORT,
    };

    // Поддерживаемые плейсхолдеры в appConfig.SERVER_NAME:
    // {protocol} — протокол подключения (например, "AmneziaWG")
    // {username} — имя клиента (clientName)
    const baseServerName = appConfig.SERVER_NAME || "";
    const protocolName = "AmneziaWG3";
    let description = baseServerName;

    if (/\{protocol\}|\{username\}/i.test(baseServerName)) {
      description = baseServerName
        .replace(/\{protocol\}/gi, protocolName)
        .replace(/\{username\}/gi, clientName);
    } else if (!baseServerName) {
      description = `${clientName} | ${protocolName}`;
    }

    // JSON для сервера
    const serverJson = {
      containers: [
        {
          awg,
          container: AppContract.AmneziaWG3.DOCKER_CONTAINER,
        },
      ],
      defaultContainer: AppContract.AmneziaWG3.DOCKER_CONTAINER,
      description,
      dns1: primaryDns,
      dns2: secondaryDns,
      hostName: endpointHost,
    };

    // Кодируем конфиг в формат vpn:// для импорта в приложение
    const clientConfig = encodeVpnConfig(serverJson);

    return {
      id: clientId,
      config: clientConfig,
      protocol: Protocol.AMNEZIAWG3,
    };
  }

  /**
   * Обновить expiresAt клиента
   */
  async updateClient(
    clientId: string,
    options: { expiresAt?: number | null; status?: PeerStatus },
  ): Promise<boolean> {
    const table = await this.amneziaWg3.readClientsTable();

    const entry = table.find(
      (x) => ((x && (x.clientId || x.publicKey)) || "") === clientId,
    );

    if (!entry) return false;

    const userData = entry.userData ?? {};
    const now = Math.floor(Date.now() / 1000);

    if (options.expiresAt !== undefined) {
      if (options.expiresAt === null) {
        delete userData.expiresAt;
      } else {
        userData.expiresAt = options.expiresAt;
      }
    }

    entry.userData = userData;
    await this.amneziaWg3.writeClientsTable(table);

    const config = await this.amneziaWg3.readWgConfig();
    if (config) {
      const currentAllowedIps = this.getPeerAllowedIps(config, clientId);

      if (
        !userData.allowedIp &&
        currentAllowedIps &&
        currentAllowedIps !== "0.0.0.0/32"
      ) {
        const firstIp = currentAllowedIps.split(",")[0].trim();
        userData.allowedIp = firstIp.includes("/")
          ? firstIp.split("/")[0]
          : firstIp;
        entry.userData = userData;
        await this.amneziaWg3.writeClientsTable(table);
      }

      const isExpired =
        typeof userData.expiresAt === "number" && userData.expiresAt <= now;
      const targetStatus =
        options.status ??
        (options.expiresAt !== undefined
          ? isExpired
            ? PeerStatus.Disabled
            : PeerStatus.Active
          : null);

      const isLegacyBlocked = this.isLegacyBlockedIp(currentAllowedIps);
      const isAlreadyRestricted =
        userData.status === PeerStatus.Disabled && !isLegacyBlocked;
      const currentlyDisabled =
        userData.status === PeerStatus.Disabled || isLegacyBlocked;
      const peerIp = this.resolvePeerIp(currentAllowedIps, userData);

      if (targetStatus === PeerStatus.Disabled && !isAlreadyRestricted) {
        if (isLegacyBlocked && peerIp) {
          const newConfig = this.updatePeerAllowedIps(
            config,
            clientId,
            `${peerIp}/32`,
          );

          if (newConfig !== config) {
            await this.amneziaWg3.writeWgConfig(newConfig);
            await this.amneziaWg3.syncWgConfig();
          }
        }

        if (peerIp) {
          await this.amneziaWg3.restrictPeerToTelegram(peerIp);
        } else {
          appLogger.warn(
            `Не удалось определить IP peer'а ${clientId} — ограничение Telegram не применено`,
          );
        }

        userData.status = PeerStatus.Disabled;
        entry.userData = userData;
        await this.amneziaWg3.writeClientsTable(table);
      } else if (targetStatus === PeerStatus.Active && currentlyDisabled) {
        if (!peerIp) {
          appLogger.warn(
            `Не удалось определить IP peer'а ${clientId} — ограничение Telegram не снято`,
          );
        } else {
          await this.amneziaWg3.removeTelegramRestriction(peerIp);

          if (isLegacyBlocked) {
            const freshConfig = await this.amneziaWg3.readWgConfig();
            const newConfig = this.updatePeerAllowedIps(
              freshConfig,
              clientId,
              `${peerIp}/32`,
            );

            if (newConfig !== freshConfig) {
              await this.amneziaWg3.writeWgConfig(newConfig);
              await this.amneziaWg3.syncWgConfig();
            }
          }

          userData.status = PeerStatus.Active;
          entry.userData = userData;
          await this.amneziaWg3.writeClientsTable(table);
        }
      }
    }

    return true;
  }

  /**
   * Удалить клиента
   */
  async deleteClient(clientId: string): Promise<boolean> {
    let table = await this.amneziaWg3.readClientsTable();

    // Сохраняем длину таблицы
    const before = table.length;

    // Ищем удаляемую запись, чтобы знать IP peer'а
    const removedEntry = table.find(
      (x) => ((x && (x.clientId || x.publicKey)) || "") === clientId,
    );

    // Удаляем клиента
    table = table.filter(
      (x) => ((x && (x.clientId || x.publicKey)) || "") !== clientId,
    );

    // Проверяем, что клиент был удален
    if (!(table.length < before)) return false;

    // Записываем обратно
    await this.amneziaWg3.writeClientsTable(table);

    // Считываем конфиг
    const config = await this.amneziaWg3.readWgConfig();

    if (config) {
      const peerIp = this.resolvePeerIp(
        this.getPeerAllowedIps(config, clientId),
        removedEntry?.userData,
      );

      // Разбиваем конфиг на секции
      const sections = config.split("[Peer]");

      // Сохраняем секции, которые не нужно удалять
      const sectionsToKeep: string[] = [];

      for (const section of sections) {
        if (!this.isPeerSection(section, clientId)) {
          sectionsToKeep.push(section);
          continue;
        }
      }

      // Собираем секции обратно в конфиг
      const newConfig = sectionsToKeep.join("[Peer]");
      await this.amneziaWg3.writeWgConfig(newConfig);

      // Применяем
      await this.amneziaWg3.syncWgConfig();

      // Снимаем ограничение Telegram, чтобы не осталось iptables-цепочки и PostUp-строки
      if (peerIp) {
        try {
          await this.amneziaWg3.removeTelegramRestriction(peerIp);
        } catch (err) {
          appLogger.warn(
            `Не удалось снять ограничение Telegram для удалённого клиента ${clientId} (${peerIp}): ${err}`,
          );
        }
      }
    }

    return true;
  }

  /**
   * Заблокировать (отключить) всех клиентов с истекшим сроком действия
   * Записи не удаляются: трафик peer'ов ограничивается только Telegram-диапазонами
   */
  async disableExpiredClients(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);

    const table = await this.amneziaWg3.readClientsTable();

    const expired = table.filter((entry) => {
      const expiresAt = entry?.userData?.expiresAt;
      return typeof expiresAt === "number" && expiresAt <= now;
    });

    if (!expired.length) return 0;

    const config = await this.amneziaWg3.readWgConfig();
    let updatedConfig = config;
    let updatedTable = false;
    const restrictedIps: string[] = [];

    if (config) {
      for (const entry of expired) {
        const clientId = entry?.clientId?.trim();
        if (!clientId) continue;

        const userData = entry.userData ?? {};
        const currentAllowedIps = this.getPeerAllowedIps(
          updatedConfig,
          clientId,
        );

        if (
          !userData.allowedIp &&
          currentAllowedIps &&
          currentAllowedIps !== "0.0.0.0/32"
        ) {
          const firstIp = currentAllowedIps.split(",")[0].trim();
          userData.allowedIp = firstIp.includes("/")
            ? firstIp.split("/")[0]
            : firstIp;
          entry.userData = userData;
          updatedTable = true;
        }

        const isLegacyBlocked = this.isLegacyBlockedIp(currentAllowedIps);

        if (userData.status === PeerStatus.Disabled && !isLegacyBlocked) {
          continue;
        }

        const peerIp = this.resolvePeerIp(currentAllowedIps, userData);

        if (!peerIp) {
          appLogger.warn(
            `Не удалось определить IP peer'а ${clientId} — ограничение Telegram не применено`,
          );
          continue;
        }

        if (isLegacyBlocked) {
          updatedConfig = this.updatePeerAllowedIps(
            updatedConfig,
            clientId,
            `${peerIp}/32`,
          );
        }

        if (userData.status !== PeerStatus.Disabled) {
          userData.status = PeerStatus.Disabled;
          entry.userData = userData;
          updatedTable = true;
        }

        restrictedIps.push(peerIp);
      }
    }

    if (updatedTable) {
      await this.amneziaWg3.writeClientsTable(table);
    }

    if (config && updatedConfig !== config) {
      await this.amneziaWg3.writeWgConfig(updatedConfig);
      await this.amneziaWg3.syncWgConfig();
    }

    for (const peerIp of restrictedIps) {
      await this.amneziaWg3.restrictPeerToTelegram(peerIp);
    }

    return expired.length;
  }
}
