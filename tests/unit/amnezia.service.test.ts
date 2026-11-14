import {
  AMNEZIA_WG_CONFIG_FIXTURE,
  AMNEZIA_WG3_CONFIG_FIXTURE,
  createAmneziaBackupFixture,
} from "../fixtures";
import { Protocol } from "@/types/shared";
import { AwgVersion } from "@/types/amnezia";
import { PeerStatus } from "@/types/clients";
import { decodeVpnConfig } from "../helpers";
import { AppContract } from "@/contracts/app";
import appConfig from "@/constants/appConfig";
import type { ProtocolFixture } from "../types";
import { createAmneziaConnectionMock } from "../mocks";
import { AmneziaWgService } from "@/services/amneziaWg";
import { AmneziaWg3Service } from "@/services/amneziaWg3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const originalAppConfig = {
  SERVER_MAX_PEERS: appConfig.SERVER_MAX_PEERS,
  SERVER_NAME: appConfig.SERVER_NAME,
  SERVER_PUBLIC_HOST: appConfig.SERVER_PUBLIC_HOST,
};

/**
 * Создать фикстуры сервисов AmneziaWG
 */
const protocolFixtures: ProtocolFixture[] = [
  {
    name: "AmneziaWgService",
    protocolName: "AmneziaWG",
    protocol: Protocol.AMNEZIAWG,
    container: AppContract.AmneziaWG.DOCKER_CONTAINER,
    createService: (connection) => new AmneziaWgService(connection),
  },
  {
    name: "AmneziaWg3Service",
    protocolName: "AmneziaWG3",
    protocol: Protocol.AMNEZIAWG3,
    container: AppContract.AmneziaWG3.DOCKER_CONTAINER,
    createService: (connection) => new AmneziaWg3Service(connection),
  },
];

/**
 * Настроить конфигурацию приложения для тестов протоколов
 */
beforeEach(() => {
  appConfig.SERVER_MAX_PEERS = 100;
  appConfig.SERVER_NAME = "{username} via {protocol}";
  appConfig.SERVER_PUBLIC_HOST = "vpn.example.com";
});

/**
 * Восстановить конфигурацию приложения
 */
afterEach(() => {
  Object.assign(appConfig, originalAppConfig);
});

/**
 * Тестирование сервисов AmneziaWG
 */
describe.each(protocolFixtures)("$name", (fixture) => {
  /**
   * Создать субъект тестирования
   */
  const createSubject = (connection = createAmneziaConnectionMock()) => ({
    service: fixture.createService(connection.connection),
    connection,
  });

  // Тестирование преобразования dump в записи клиентов
  it("maps active and disabled peers from the WireGuard dump", async () => {
    const { service } = createSubject();

    const clients = await service.getClients();

    expect(clients).toHaveLength(2);
    expect(clients[0]).toMatchObject({
      username: "alice",
      peers: [
        {
          id: "active-id",
          name: "macbook",
          status: PeerStatus.Active,
          traffic: { received: 100, sent: 200 },
          protocol: fixture.protocol,
        },
      ],
    });
    expect(clients[1]).toMatchObject({
      username: "bob",
      peers: [
        {
          id: "disabled-id",
          status: PeerStatus.Disabled,
          protocol: fixture.protocol,
        },
      ],
    });
  });

  // Тестирование создания клиента и конфигурации vpn://
  it("creates a client and returns an importable VPN config", async () => {
    const { service, connection } = createSubject();

    const result = await service.createClient("charlie", {
      expiresAt: 4_102_444_800,
    });

    expect(result).toMatchObject({
      id: "generated-client-id",
      protocol: fixture.protocol,
    });
    expect(result.config).toMatch(/^vpn:\/\//);
    expect(connection.state.wgConfig).toContain(
      "PublicKey = generated-client-id",
    );
    expect(connection.state.clientsTable.at(-1)).toMatchObject({
      clientId: "generated-client-id",
      userData: {
        clientName: "charlie",
        expiresAt: 4_102_444_800,
      },
    });
    expect(decodeVpnConfig(result.config)).toMatchObject({
      defaultContainer: fixture.container,
      description: `charlie via ${fixture.protocolName}`,
      hostName: "vpn.example.com",
    });
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });

  // Тестирование удаления клиента из таблицы и конфигурации
  it("deletes a client without removing other peers", async () => {
    const { service, connection } = createSubject();

    await expect(service.deleteClient("active-id")).resolves.toBe(true);

    expect(connection.state.clientsTable).toHaveLength(1);
    expect(connection.state.clientsTable[0]?.clientId).toBe("disabled-id");
    expect(connection.state.wgConfig).not.toContain("PublicKey = active-id");
    expect(connection.state.wgConfig).toContain("PublicKey = disabled-id");
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();

    await expect(service.deleteClient("missing-id")).resolves.toBe(false);
  });

  // Тестирование экспорта и импорта резервной копии
  it("exports and imports all protocol backup files", async () => {
    const { service, connection } = createSubject();

    await expect(service.exportBackup()).resolves.toEqual(
      createAmneziaBackupFixture(),
    );

    const backup = {
      ...createAmneziaBackupFixture(),
      wgConfig: "[Interface]\nAddress = 10.9.0.1/24\n",
      serverPublicKey: " imported-public-key ",
      presharedKey: " imported-preshared-key ",
      clients: [],
    };

    await service.importBackup(backup);

    expect(connection.state.wgConfig).toBe(backup.wgConfig);
    expect(connection.state.clientsTable).toEqual([]);
    expect(Object.values(connection.state.files)).toContain(
      "imported-public-key\n",
    );
    expect(Object.values(connection.state.files)).toContain(
      "imported-preshared-key\n",
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });
});

/**
 * AmneziaWg3Service: wg0.conf — источник истины для peer'ов и AllowedIPs,
 * dump используется только для runtime статистики.
 */
describe("AmneziaWg3Service — config-driven getClients", () => {
  const createSubject = (
    options: Parameters<typeof createAmneziaConnectionMock>[0] = {},
  ) => {
    const connection = createAmneziaConnectionMock(options);
    return {
      service: new AmneziaWg3Service(connection.connection),
      connection,
    };
  };

  it("reports a config-blocked peer even when the live dump shows no allowed IPs", async () => {
    const wgConfig = `[Interface]
Address = 10.8.1.1/24
ListenPort = 51820

[Peer]
PublicKey = blocked-config-id
AllowedIPs = 0.0.0.0/32
`;
    const wgDump = [
      "blocked-config-id\tpsk\t(none)\t(none)\t0\t0\t0\toff",
      "stale-id\tpsk\t198.51.100.10:51820\t10.8.1.5/32\t0\t100\t200\t25",
    ].join("\n");
    const { service } = createSubject({
      wgConfig,
      wgDump,
      clientsTable: [
        {
          clientId: "blocked-config-id",
          userData: { clientName: "blocked-user", allowedIp: "10.8.1.4" },
        },
      ],
    });

    const clients = await service.getClients();

    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      username: "blocked-user",
      peers: [
        {
          id: "blocked-config-id",
          status: PeerStatus.Disabled,
          allowedIps: ["0.0.0.0/32"],
          endpoint: null,
          traffic: { received: 0, sent: 0 },
          online: false,
        },
      ],
    });
  });

  it("reports a config-disabled peer that has no entry in the live dump", async () => {
    const wgConfig = `[Interface]
Address = 10.8.1.1/24

[Peer]
PublicKey = disabled-only-config
AllowedIPs = 0.0.0.0/32
`;
    const { service } = createSubject({
      wgConfig,
      wgDump: "",
      clientsTable: [
        {
          clientId: "disabled-only-config",
          userData: { clientName: "ghost" },
        },
      ],
    });

    const clients = await service.getClients();

    expect(clients).toEqual([
      {
        username: "ghost",
        peers: [
          expect.objectContaining({
            id: "disabled-only-config",
            status: PeerStatus.Disabled,
            allowedIps: ["0.0.0.0/32"],
            endpoint: null,
            online: false,
            traffic: { received: 0, sent: 0 },
            expiresAt: null,
            protocol: Protocol.AMNEZIAWG3,
          }),
        ],
      },
    ]);
  });

  it("uses config AllowedIPs when the dump shows (none)", async () => {
    const wgConfig = `[Interface]
Address = 10.8.1.1/24

[Peer]
PublicKey = active-with-confused-dump
AllowedIPs = 10.8.1.7/32
`;
    const wgDump =
      "active-with-confused-dump\tpsk\t198.51.100.10:51820\t(none)\t0\t100\t200\t25";
    const { service } = createSubject({
      wgConfig,
      wgDump,
      clientsTable: [
        {
          clientId: "active-with-confused-dump",
          userData: { clientName: "alive" },
        },
      ],
    });

    const clients = await service.getClients();

    expect(clients[0]?.peers[0]).toMatchObject({
      id: "active-with-confused-dump",
      status: PeerStatus.Active,
      allowedIps: ["10.8.1.7/32"],
      traffic: { received: 100, sent: 200 },
    });
  });

  it("ignores dump-only peers that are absent from wg0.conf", async () => {
    const wgConfig = `[Interface]
Address = 10.8.1.1/24

[Peer]
PublicKey = in-config
AllowedIPs = 10.8.1.2/32
`;
    const wgDump = [
      "in-config\tpsk\t198.51.100.10:51820\t10.8.1.2/32\t0\t1\t2\t25",
      "stale-only-in-dump\tpsk\t198.51.100.10:51820\t10.8.1.9/32\t0\t3\t4\t25",
    ].join("\n");
    const { service } = createSubject({
      wgConfig,
      wgDump,
      clientsTable: [
        {
          clientId: "in-config",
          userData: { clientName: "kept" },
        },
      ],
    });

    const clients = await service.getClients();

    expect(clients).toHaveLength(1);
    expect(clients[0]?.peers).toHaveLength(1);
    expect(clients[0]?.peers[0]?.id).toBe("in-config");
  });
});

/**
 * AmneziaWgService: отключение клиента — блокировка через AllowedIPs = 0.0.0.0/32
 */
describe("AmneziaWgService — legacy AllowedIPs blocking", () => {
  const createSubject = (connection = createAmneziaConnectionMock()) => ({
    service: new AmneziaWgService(connection.connection),
    connection,
  });

  it("disables a client and restores its original allowed IP", async () => {
    const { service, connection } = createSubject();

    await expect(
      service.updateClient("active-id", { status: PeerStatus.Disabled }),
    ).resolves.toBe(true);
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 0\.0\.0\.0\/32/,
    );
    expect(connection.spies.restrictPeerToTelegram).not.toHaveBeenCalled();

    await expect(
      service.updateClient("active-id", { status: PeerStatus.Active }),
    ).resolves.toBe(true);
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 10\.8\.1\.2\/32/,
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledTimes(2);
  });

  it("disables expired clients and preserves their original IP", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: AMNEZIA_WG_CONFIG_FIXTURE,
      clientsTable: [
        {
          clientId: "active-id",
          userData: {
            clientName: "expired",
            expiresAt: 1_700_000_000,
          },
        },
      ],
    });
    const { service } = createSubject(connection);

    await expect(service.disableExpiredClients()).resolves.toBe(1);

    expect(connection.state.clientsTable[0]?.userData?.allowedIp).toBe(
      "10.8.1.2",
    );
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 0\.0\.0\.0\/32/,
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });
});

/**
 * AmneziaWg3Service: отключение клиента — ограничение трафика только Telegram
 * через scripts/telegram-restrict.sh внутри контейнера amnezia-awg2.
 */
describe("AmneziaWg3Service — telegram restriction", () => {
  const createSubject = (connection = createAmneziaConnectionMock()) => ({
    service: new AmneziaWg3Service(connection.connection),
    connection,
  });

  const findEntry = (connection: ReturnType<typeof createAmneziaConnectionMock>, clientId: string) =>
    connection.state.clientsTable.find((x) => x?.clientId === clientId);

  it("restricts a disabled peer to Telegram and keeps its config IP", async () => {
    const { service, connection } = createSubject();

    await expect(
      service.updateClient("active-id", { status: PeerStatus.Disabled }),
    ).resolves.toBe(true);

    expect(connection.spies.restrictPeerToTelegram).toHaveBeenCalledOnce();
    expect(connection.spies.restrictPeerToTelegram).toHaveBeenCalledWith(
      "10.8.1.2",
    );
    expect(connection.spies.removeTelegramRestriction).not.toHaveBeenCalled();
    expect(connection.spies.writeWgConfig).not.toHaveBeenCalled();
    expect(connection.spies.syncWgConfig).not.toHaveBeenCalled();
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 10\.8\.1\.2\/32/,
    );
    expect(findEntry(connection, "active-id")?.userData?.status).toBe(
      PeerStatus.Disabled,
    );
  });

  it("reports a telegram-restricted peer as disabled with its real IP", async () => {
    const { service } = createSubject();

    await service.updateClient("active-id", { status: PeerStatus.Disabled });

    const clients = await service.getClients();
    const alice = clients.find((c) => c.username === "alice");

    expect(alice?.peers[0]).toMatchObject({
      id: "active-id",
      status: PeerStatus.Disabled,
      allowedIps: ["10.8.1.2/32"],
    });
  });

  it("reenables a peer by removing the Telegram restriction", async () => {
    const { service, connection } = createSubject();

    await service.updateClient("active-id", { status: PeerStatus.Disabled });
    await expect(
      service.updateClient("active-id", { status: PeerStatus.Active }),
    ).resolves.toBe(true);

    expect(connection.spies.removeTelegramRestriction).toHaveBeenCalledOnce();
    expect(connection.spies.removeTelegramRestriction).toHaveBeenCalledWith(
      "10.8.1.2",
    );
    expect(connection.spies.writeWgConfig).not.toHaveBeenCalled();
    expect(connection.spies.syncWgConfig).not.toHaveBeenCalled();
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 10\.8\.1\.2\/32/,
    );
    expect(findEntry(connection, "active-id")?.userData?.status).toBe(
      PeerStatus.Active,
    );
  });

  it("does not touch the container when the requested state is already applied", async () => {
    const { service, connection } = createSubject();

    await expect(
      service.updateClient("active-id", { status: PeerStatus.Active }),
    ).resolves.toBe(true);
    expect(connection.spies.removeTelegramRestriction).not.toHaveBeenCalled();

    await service.updateClient("active-id", { status: PeerStatus.Disabled });
    await expect(
      service.updateClient("active-id", { status: PeerStatus.Disabled }),
    ).resolves.toBe(true);

    expect(connection.spies.restrictPeerToTelegram).toHaveBeenCalledOnce();
  });

  it("restores the IP of a legacy-blocked peer before restricting it", async () => {
    const wgConfig = `[Interface]
Address = 10.8.1.1/24
ListenPort = 51820

[Peer]
PublicKey = legacy-id
AllowedIPs = 0.0.0.0/32
`;
    const connection = createAmneziaConnectionMock({
      wgConfig,
      clientsTable: [
        {
          clientId: "legacy-id",
          userData: { clientName: "legacy", allowedIp: "10.8.1.5" },
        },
      ],
    });
    const { service } = createSubject(connection);

    await expect(
      service.updateClient("legacy-id", { status: PeerStatus.Disabled }),
    ).resolves.toBe(true);

    expect(connection.state.wgConfig).toMatch(
      /PublicKey = legacy-id\nAllowedIPs = 10\.8\.1\.5\/32/,
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
    expect(connection.spies.restrictPeerToTelegram).toHaveBeenCalledWith(
      "10.8.1.5",
    );
    expect(
      connection.state.clientsTable.find((x) => x?.clientId === "legacy-id")
        ?.userData?.status,
    ).toBe(PeerStatus.Disabled);
  });

  it("removes the restriction and restores the IP when enabling a legacy-blocked peer", async () => {
    const wgConfig = `[Interface]
Address = 10.8.1.1/24
ListenPort = 51820

[Peer]
PublicKey = legacy-id
AllowedIPs = 0.0.0.0/32
`;
    const connection = createAmneziaConnectionMock({
      wgConfig,
      clientsTable: [
        {
          clientId: "legacy-id",
          userData: { clientName: "legacy", allowedIp: "10.8.1.5" },
        },
      ],
    });
    const { service } = createSubject(connection);

    await expect(
      service.updateClient("legacy-id", { status: PeerStatus.Active }),
    ).resolves.toBe(true);

    expect(connection.spies.removeTelegramRestriction).toHaveBeenCalledWith(
      "10.8.1.5",
    );
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = legacy-id\nAllowedIPs = 10\.8\.1\.5\/32/,
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
    expect(
      connection.state.clientsTable.find((x) => x?.clientId === "legacy-id")
        ?.userData?.status,
    ).toBe(PeerStatus.Active);
  });

  it("restricts expired clients to Telegram without zeroing their IPs", async () => {
    const connection = createAmneziaConnectionMock({
      clientsTable: [
        {
          clientId: "active-id",
          userData: {
            clientName: "expired",
            expiresAt: 1_700_000_000,
          },
        },
      ],
    });
    const { service } = createSubject(connection);

    await expect(service.disableExpiredClients()).resolves.toBe(1);

    expect(connection.state.clientsTable[0]?.userData?.allowedIp).toBe(
      "10.8.1.2",
    );
    expect(connection.state.clientsTable[0]?.userData?.status).toBe(
      PeerStatus.Disabled,
    );
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 10\.8\.1\.2\/32/,
    );
    expect(connection.spies.restrictPeerToTelegram).toHaveBeenCalledWith(
      "10.8.1.2",
    );
    expect(connection.spies.writeWgConfig).not.toHaveBeenCalled();
    expect(connection.spies.syncWgConfig).not.toHaveBeenCalled();
  });

  it("skips expired clients that are already telegram-restricted", async () => {
    const connection = createAmneziaConnectionMock({
      clientsTable: [
        {
          clientId: "active-id",
          userData: {
            clientName: "expired",
            expiresAt: 1_700_000_000,
            allowedIp: "10.8.1.2",
            status: PeerStatus.Disabled,
          },
        },
      ],
    });
    const { service } = createSubject(connection);

    await expect(service.disableExpiredClients()).resolves.toBe(1);

    expect(connection.spies.restrictPeerToTelegram).not.toHaveBeenCalled();
  });

  it("removes the Telegram restriction when deleting a client", async () => {
    const { service, connection } = createSubject();

    await expect(service.deleteClient("active-id")).resolves.toBe(true);

    expect(connection.spies.removeTelegramRestriction).toHaveBeenCalledWith(
      "10.8.1.2",
    );
    expect(connection.state.wgConfig).not.toContain("PublicKey = active-id");
  });

  it("still deletes a client when restriction cleanup fails", async () => {
    const connection = createAmneziaConnectionMock();
    connection.spies.removeTelegramRestriction.mockRejectedValueOnce(
      new Error("script missing"),
    );
    const { service } = createSubject(connection);

    await expect(service.deleteClient("active-id")).resolves.toBe(true);

    expect(connection.state.wgConfig).not.toContain("PublicKey = active-id");
    expect(connection.state.clientsTable).toHaveLength(1);
  });

  it("keeps PostUp hooks in the interface section when rewriting the config", async () => {
    const postUpLine =
      "PostUp = /usr/local/bin/telegram-restrict.sh 10.8.1.2 awg0 /opt/amnezia/awg/awg0.conf";
    const wgConfig = `[Interface]
Address = 10.8.1.1/24
ListenPort = 51820
${postUpLine}

[Peer]
PublicKey = active-id
AllowedIPs = 0.0.0.0/32
`;
    const connection = createAmneziaConnectionMock({
      wgConfig,
      clientsTable: [
        {
          clientId: "active-id",
          userData: { clientName: "alice", allowedIp: "10.8.1.2" },
        },
      ],
    });
    const { service } = createSubject(connection);

    const clients = await service.getClients();
    expect(clients[0]?.peers[0]).toMatchObject({
      id: "active-id",
      status: PeerStatus.Disabled,
      allowedIps: ["0.0.0.0/32"],
    });

    await service.updateClient("active-id", { status: PeerStatus.Active });

    expect(connection.spies.writeWgConfig).toHaveBeenCalledOnce();
    expect(connection.state.wgConfig).toContain(postUpLine);
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 10\.8\.1\.2\/32/,
    );
  });

  it("creates a client on a config that contains PostUp hooks", async () => {
    const postUpLine =
      "PostUp = /usr/local/bin/telegram-restrict.sh 10.8.1.2 awg0 /opt/amnezia/awg/awg0.conf";
    const wgConfig = AMNEZIA_WG_CONFIG_FIXTURE.replace(
      "[Interface]\n",
      `[Interface]\n${postUpLine}\n`,
    );
    const connection = createAmneziaConnectionMock({ wgConfig });
    const { service } = createSubject(connection);

    const result = await service.createClient("charlie");

    expect(result.id).toBe("generated-client-id");
    expect(connection.state.wgConfig).toContain("PublicKey = generated-client-id");
    expect(connection.state.wgConfig).toContain(postUpLine);
    expect(connection.state.wgConfig).toMatch(
      /AllowedIPs = 10\.8\.1\.1\/32/,
    );
  });
});

/**
 * Прочитать параметры контейнера awg из конфигурации vpn://
 */
const readAwgContainer = (config: string) => {
  const decoded = decodeVpnConfig(config) as unknown as {
    containers: { awg: Record<string, string> }[];
  };

  const awg = decoded.containers[0].awg;

  return {
    awg,
    lastConfig: JSON.parse(awg.last_config) as Record<string, unknown>,
  };
};

/**
 * Тестирование клиентских конфигов AmneziaWG 3.1
 */
describe("AmneziaWg3Service", () => {
  /**
   * Создать субъект тестирования
   */
  const createSubject = (wgConfig = AMNEZIA_WG3_CONFIG_FIXTURE) => {
    const connection = createAmneziaConnectionMock({ wgConfig });

    return {
      service: new AmneziaWg3Service(connection.connection),
      connection,
    };
  };

  // Тестирование переноса параметров 3.1 в клиентский конфиг
  it("passes AmneziaWG 3.1 parameters to the client config", async () => {
    const { service } = createSubject();

    const { config } = await service.createClient("charlie");
    const { awg, lastConfig } = readAwgContainer(config);

    expect(awg).toMatchObject({
      protocol_version: AwgVersion.V3_1,
      ContentPaddingAddition: "10-100",
      RekeyAfterTime: "100-120",
      RekeyTimeout: "3-7",
      RejectAfterTime: "150-180",
      KeepaliveTimeout: "5-15",
      MaxHandshakeAttempts: "15-20",
      RandomTrailers: "on",
      DisableCookies: "on",
      S3: "20",
      S4: "23",
      I2: "",
    });
    expect(awg.HeaderProtectionKey).toBeTruthy();
    expect(lastConfig.persistent_keep_alive).toBe("25-35");

    const clientConfig = lastConfig.config as string;

    expect(clientConfig).toContain(
      `HeaderProtectionKey = ${awg.HeaderProtectionKey}`,
    );
    expect(clientConfig).toContain("RandomTrailers = on");
    expect(clientConfig).toContain("DisableCookies = on");
    expect(clientConfig).toContain("MaxHandshakeAttempts = 15-20");
    expect(clientConfig).toContain("PersistentKeepalive = 25-35");
    expect(clientConfig).toContain("Endpoint = vpn.example.com:51820");
  });

  // Тестирование чтения закомментированных в серверном конфиге I1–I5
  it("takes special junk from the commented server config lines", async () => {
    const { service } = createSubject();

    const { config } = await service.createClient("charlie");
    const { lastConfig } = readAwgContainer(config);
    const clientConfig = lastConfig.config as string;

    expect(clientConfig).toContain("I1 = <r 2><b 0x8580");
    expect(clientConfig).not.toMatch(/^I2 =/m);
  });

  // Тестирование того, что незаданные параметры не попадают в конфиг
  it("drops parameters missing in the server config", async () => {
    const { service } = createSubject(
      AMNEZIA_WG3_CONFIG_FIXTURE.replace(/^S3 =.*$\n^S4 =.*$\n/m, "").replace(
        /^DisableCookies =.*$\n/m,
        "",
      ),
    );

    const { config } = await service.createClient("charlie");
    const { awg, lastConfig } = readAwgContainer(config);
    const clientConfig = lastConfig.config as string;

    expect(awg.protocol_version).toBe(AwgVersion.V3_1);
    expect(awg.S3).toBeUndefined();
    expect(awg.DisableCookies).toBeUndefined();
    expect(clientConfig).not.toContain("S3 =");
    expect(clientConfig).not.toContain("DisableCookies");
    expect(clientConfig).not.toMatch(/^\s*\S+\s*=\s*$/m);
  });

  // Тестирование сервера, оставшегося на AmneziaWG 2.0
  it("builds a 2.0 client config when the server has no 3.1 parameters", async () => {
    const { service } = createSubject(AMNEZIA_WG_CONFIG_FIXTURE);

    const { config } = await service.createClient("charlie");
    const { awg, lastConfig } = readAwgContainer(config);

    expect(awg.protocol_version).toBe(AwgVersion.V2);
    expect(awg.HeaderProtectionKey).toBeUndefined();
    expect(awg.RandomTrailers).toBeUndefined();
    expect(lastConfig.persistent_keep_alive).toBe(
      AppContract.AmneziaWG3.DEFAULTS.KEEPALIVE,
    );

    const clientConfig = lastConfig.config as string;

    expect(clientConfig).toContain("S3 = 20");
    expect(clientConfig).toContain("I2 = test-2");
    expect(clientConfig).toContain(
      `PersistentKeepalive = ${AppContract.AmneziaWG3.DEFAULTS.KEEPALIVE}`,
    );
    expect(clientConfig).not.toContain("HeaderProtectionKey");
    expect(clientConfig).not.toContain("DisableCookies");
  });

  // Тестирование подстановки дефолтов для неполного конфига 2.0
  it("falls back to defaults when the 2.0 server config is incomplete", async () => {
    const { service } = createSubject(
      AMNEZIA_WG_CONFIG_FIXTURE.replace(/^S3 =.*$\n^S4 =.*$\n/m, "").replace(
        /^I1 =.*$\n/m,
        "",
      ),
    );

    const { config } = await service.createClient("charlie");
    const { awg, lastConfig } = readAwgContainer(config);

    expect(awg).toMatchObject({ S3: "20", S4: "23" });
    expect(lastConfig.config as string).toContain("I1 = <r 2><b 0x8580");
  });
});
