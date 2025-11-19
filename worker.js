// Child process worker that performs the probe and sends messages to the parent via process.send

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
let config = null;
let userDataPath = null;

function send(type, payload = {}) {
  try { process.send({ type, ...payload }); } catch (e) { /* parent may have closed */ }
}

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'start') return;
  config = msg.config;
  userDataPath = msg.userDataPath;

  const logPath = path.join(userDataPath, 'logs');
  try { fs.mkdirSync(logPath, { recursive: true }); } catch (e) {}
  const logfile = path.join(
    logPath,
    `opcua-endpoint-diagnostic_${new Date().toISOString().replace(/[:.]/g,'-')}.log`
  );

  function appendLog(text) {
    fs.appendFileSync(logfile, `[${new Date().toISOString()}] ${text}\n`);
    send('log', { message: text });
  }

  appendLog('Probe started: ' + JSON.stringify(config));

  try {
    // Step 1: Query endpoints
    send('progress', { progress: 10, task: 'Querying endpoints' });
    appendLog('Querying endpoints');
    const endpoints = await queryEndpoints(config.server, config.port);
    appendLog('Endpoints received');
    send('result-partial', { payload: { endpoints } });

    // Step 2: Record listening ports before subscription
    send('progress', { progress: 25, task: 'Recording listening ports (before)' });
    const beforeListeners = await getListeningPorts();
    appendLog('Before listening ports captured');
    send('result-partial', { payload: { beforeListeners } });

    // Step 3: Create subscription (attempt)
    send('progress', { progress: 45, task: 'Creating subscription and monitored item' });
    appendLog('Creating subscription');
    const subscriptionResult = await createSubscriptionAndMonitor(config);
    appendLog('Subscription created/attempted');
    send('result-partial', { payload: { subscriptionResult } });

    // Step 4: Record listening ports after subscription
    send('progress', { progress: 65, task: 'Recording listening ports (after)' });
    const afterListeners = await getListeningPorts();
    appendLog('After listening ports captured');
    send('result-partial', { payload: { afterListeners } });

    // Step 5: Monitor for incoming connections from server IP (30s)
    send('progress', { progress: 75, task: 'Monitoring incoming connection attempts (30s)' });
    appendLog('Monitoring incoming connections');
    const serverIp = extractHostFromEndpoint(config.server) || null;
    const serverPort = config.port;
    const connections = await monitorConnectionAttempts(serverIp, serverPort, 30 * 1000);
    appendLog('Monitoring complete');
    send('result-partial', { payload: { connections } });

    // Final aggregation
    const final = { endpoints, beforeListeners, subscriptionResult, afterListeners, connections };
    send('result-final', { payload: final });
    appendLog('Probe finished');
    process.exit(0);
  } catch (err) {
    appendLog('Probe error: ' + (err.stack || err.message || err));
    send('error', { error: String(err) });
    process.exit(1);
  }
});

// ------------------------ Helper implementations ------------------------
const { OPCUAClient, MessageSecurityMode, SecurityPolicy } = require('node-opcua');

async function queryEndpoints(serverUrl, port) {
  const endpointUrl = normalizeEndpoint(serverUrl, port);
  const client = OPCUAClient.create({ connectionStrategy: { initialDelay: 1000, maxRetry: 0 } });
  try {
    await client.connect(endpointUrl);
    const endpoints = await client.getEndpoints();
    await client.disconnect();
    return endpoints.map(e => ({
      endpointUrl: e.endpointUrl,
      securityPolicyUri: e.securityPolicyUri,
      securityMode: e.securityMode,
      userIdentityTokens: e.userIdentityTokens && e.userIdentityTokens.map(t => t.tokenType)
    }));
  } catch (err) {
    try { await client.disconnect(); } catch (e) {}
    throw err;
  }
}

// ---------------- HARD-CODED PROTOCOL HERE ----------------
function normalizeEndpoint(server, port) {
  if (!server) throw new Error('server missing');

  // Normalize whitespace
  server = String(server).trim();

  // If the user pasted a full opc.tcp URL, strip the protocol part
  // Example: "opc.tcp://192.168.1.10:4840" -> "192.168.1.10:4840"
  if (server.toLowerCase().startsWith('opc.tcp://')) {
    server = server.slice('opc.tcp://'.length);
  }

  // If the user pasted "host:port" or "ip:port", split and use that port
  // Example: "192.168.1.10:4840" -> host="192.168.1.10", port="4840"
  const hostPortMatch = server.match(/^(.+?):(\d+)$/);
  if (hostPortMatch) {
    server = hostPortMatch[1];
    if (!port) {
      port = hostPortMatch[2];
    }
  }

  if (!port) {
    throw new Error('port missing');
  }

  // At this point:
  //   server = hostname/IP only
  //   port   = numeric string
  // Protocol is ALWAYS hard-coded here:
  return `opc.tcp://${server}:${port}`;
}

async function createSubscriptionAndMonitor(cfg) {
  // This function attempts to create a subscription and monitored item and returns data about the subscription.
  const endpointUrl = normalizeEndpoint(cfg.server, cfg.port);
  const client = OPCUAClient.create({ keepSessionAlive: true });
  let session, subscription;
  try {
    await client.connect(endpointUrl);
    session = await client.createSession();

    subscription = await session.createSubscription2({
      requestedPublishingInterval: cfg.publishingInterval || 250,
      requestedLifetimeCount: 10000,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true
    });

    const itemToMonitor = cfg.nodeId || 'ns=0;i=2258';
    const monitoredItem = await subscription.monitor(
      { nodeId: itemToMonitor, attributeId: 13 },
      { samplingInterval: cfg.publishingInterval || 250, discardOldest: true, queueSize: 10 },
      0
    );

    // Wait a short while to allow socket/listener to appear
    await new Promise(resolve => setTimeout(resolve, 1500));

    // clean up
    try { await subscription.terminate(); } catch(e){}
    try { await session.close(); } catch(e){}
    try { await client.disconnect(); } catch(e){}

    return { success: true, nodeMonitored: itemToMonitor };
  } catch (err) {
    try { if (subscription) await subscription.terminate(); } catch(e){}
    try { if (session) await session.close(); } catch(e){}
    try { await client.disconnect(); } catch(e){}
    return { success: false, error: String(err) };
  }
}

// ---------------- ROBUST HOST EXTRACTION ----------------
function extractHostFromEndpoint(endpoint) {
  if (!endpoint) return null;

  try {
    // If it's a full URL like "opc.tcp://192.168.1.10:4840"
    const url = new URL(endpoint);
    return url.hostname;
  } catch (e) {
    // Not a full URL; try a few patterns
    const text = String(endpoint).trim();

    // If it still has opc.tcp:// but URL constructor failed for some reason
    const mOpc = text.match(/^opc\.tcp:\/\/([^\/:]+)(?::\d+)?/i);
    if (mOpc) return mOpc[1];

    // If it's just "host:port"
    const mHostPort = text.match(/^(.+?):\d+$/);
    if (mHostPort) return mHostPort[1];

    // If it's just "host" or "ip"
    return text || null;
  }
}

function getListeningPorts() {
  return new Promise((resolve, reject) => {
    exec('netstat -ano', { windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      const lines = stdout.split(/\r?\n/).slice(4).filter(l => l.trim());
      const listeners = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // Expected: Proto  Local Address  Foreign Address  State  PID
        if (parts.length >= 5) {
          const proto = parts[0];
          const local = parts[1];
          const state = parts[3] || '';
          const pid = parts[4] || '';
          if (/LISTENING/i.test(state) || state === 'LISTEN') {
            const [addr, port] = parseAddressPort(local);
            listeners.push({ proto, localAddress: addr, localPort: port, pid });
          }
        }
      }
      resolve(listeners);
    });
  });
}

function parseAddressPort(text) {
  const idx = text.lastIndexOf(':');
  if (idx === -1) return [text, ''];
  const addr = text.substring(0, idx);
  const port = text.substring(idx + 1);
  return [addr, port];
}

function monitorConnectionAttempts(serverIp, serverPort, durationMs) {
  // Fallback implementation: poll netstat every 2s for connections from serverIp to any local port
  const polls = Math.ceil(durationMs / 2000);
  const found = [];

  return new Promise((resolve) => {
    let i = 0;
    const t = setInterval(() => {
      exec('netstat -ano', { windowsHide: true }, (err, stdout) => {
        if (!err && stdout) {
          const lines = stdout.split(/\r?\n/).slice(4).filter(l => l.trim());
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5) {
              const proto = parts[0];
              const local = parts[1];
              const remote = parts[2];
              const state = parts[3] || '';
              const pid = parts[4] || '';
              if (serverIp && remote.includes(serverIp)) {
                const [rAddr, rPort] = parseAddressPort(remote);
                const [lAddr, lPort] = parseAddressPort(local);
                // record TCP states and timestamps
                found.push({
                  timestamp: new Date().toISOString(),
                  proto,
                  localAddress: lAddr,
                  localPort: lPort,
                  remoteAddress: rAddr,
                  remotePort: rPort,
                  state,
                  pid
                });
              }
            }
          }
        }
      });

      i++;
      send('progress', {
        progress: 75 + Math.round((i / polls) * 15),
        task: `Monitoring incoming connections (${i}/${polls})`
      });
      if (i >= polls) {
        clearInterval(t);
        resolve(found);
      }
    }, 2000);
  });
}
