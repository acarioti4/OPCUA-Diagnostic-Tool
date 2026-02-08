/**
 * Worker process - OPC-UA diagnostic operations
 * Runs in separate Node.js process to keep UI responsive and isolate OPC-UA operations
 * 
 * Probe workflow:
 * 1. Query OPC-UA server endpoints
 * 2. Capture baseline listening ports (before subscription)
 * 3. Create OPC-UA subscription and monitored item
 * 4. Capture listening ports after subscription (identify callback listeners)
 * 5. Monitor for incoming connections from server (callback attempts)
 * 6. Write comprehensive log file with all results
 */

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

  const errors = [];
  const warnings = [];

  // Dual logging: simple messages go to UI + file, detailed messages only to file
  function appendLog(text, isDetailed = false) {
    if (!isDetailed) {
      send('log', { message: text });
    }
    fs.appendFileSync(logfile, `[${new Date().toISOString()}] ${text}\n`);
  }

  function appendDetailedLog(title, data, summary = null) {
    appendLog(`\n========== ${title} ==========`, true);
    if (summary) {
      appendLog(`Summary: ${summary}`, true);
    }
    if (data !== null && data !== undefined) {
      try {
        const jsonStr = JSON.stringify(data);
        appendLog(`Detailed Data: ${jsonStr}`, true);
      } catch (e) {
        appendLog(`Detailed Data (stringified): ${String(data)}`, true);
      }
    }
    appendLog(`========== End ${title} ==========\n`, true);
  }

  function logError(error, context = '') {
    const errorObj = {
      timestamp: new Date().toISOString(),
      context,
      message: error?.message || String(error),
      stack: error?.stack || null,
      name: error?.name || 'Error',
      code: error?.code || null,
      fullError: String(error)
    };
    errors.push(errorObj);
    
    appendLog(`\n========== ERROR DETECTED ==========`, true);
    appendLog(`Context: ${context}`, true);
    appendLog(`Error Name: ${errorObj.name}`, true);
    appendLog(`Error Message: ${errorObj.message}`, true);
    if (errorObj.code) {
      appendLog(`Error Code: ${errorObj.code}`, true);
    }
    if (errorObj.stack) {
      appendLog(`Stack Trace:\n${errorObj.stack}`, true);
    } else {
      appendLog(`Full Error: ${errorObj.fullError}`, true);
    }
    appendLog(`========== END ERROR ==========\n`, true);
  }

  function logWarning(warning, context = '') {
    const warningObj = {
      timestamp: new Date().toISOString(),
      context,
      message: String(warning)
    };
    warnings.push(warningObj);
    appendLog(`[WARNING] ${context}: ${warningObj.message}`, true);
  }

  function writeErrorSummary() {
    if (errors.length === 0 && warnings.length === 0) {
      return;
    }

    appendLog(`\n\n========== ERROR AND WARNING SUMMARY ==========`, true);
    
    if (errors.length > 0) {
      appendLog(`\nTotal Errors: ${errors.length}`, true);
      errors.forEach((err, idx) => {
        appendLog(`\n--- Error ${idx + 1} ---`, true);
        appendLog(`  Time: ${err.timestamp}`, true);
        appendLog(`  Context: ${err.context || 'Unknown'}`, true);
        appendLog(`  Type: ${err.name}`, true);
        appendLog(`  Message: ${err.message}`, true);
        if (err.code) {
          appendLog(`  Code: ${err.code}`, true);
        }
        if (err.stack) {
          appendLog(`  Stack Trace:\n${err.stack.split('\n').map(l => '    ' + l).join('\n')}`, true);
        }
      });
    }

    if (warnings.length > 0) {
      appendLog(`\nTotal Warnings: ${warnings.length}`, true);
      warnings.forEach((warn, idx) => {
        appendLog(`\n--- Warning ${idx + 1} ---`, true);
        appendLog(`  Time: ${warn.timestamp}`, true);
        appendLog(`  Context: ${warn.context || 'Unknown'}`, true);
        appendLog(`  Message: ${warn.message}`, true);
      });
    }

    appendLog(`\n========== END ERROR AND WARNING SUMMARY ==========\n\n`, true);
  }

  appendLog('Probe started');
  appendDetailedLog('Probe Configuration', config, 'Initial probe configuration parameters');

  try {
    // Step 1: Query OPC-UA server endpoints (security policy info)
    send('progress', { progress: 10, task: 'Querying endpoints' });
    appendLog('Querying endpoints');
    const endpointUrl = normalizeEndpoint(config.server, config.port);
    appendLog(`Connecting to endpoint: ${endpointUrl}`);
    
    let endpoints;
    try {
      endpoints = await queryEndpoints(config.server, config.port);
      appendLog(`Successfully retrieved ${endpoints?.length || 0} endpoint(s)`);
      
      if (endpoints && endpoints.length > 0) {
        const endpointSummary = {
          total: endpoints.length,
          securityPolicies: {},
          securityModes: {},
          userTokenTypes: []
        };
        const userTokenTypesSet = new Set();
        
        endpoints.forEach((ep, idx) => {
          const policy = ep.securityPolicyUri || 'Unknown';
          const mode = ep.securityMode || 'Unknown';
          endpointSummary.securityPolicies[policy] = (endpointSummary.securityPolicies[policy] || 0) + 1;
          endpointSummary.securityModes[mode] = (endpointSummary.securityModes[mode] || 0) + 1;
          if (ep.userIdentityTokens) {
            ep.userIdentityTokens.forEach(t => userTokenTypesSet.add(t));
          }
        });
        
        endpointSummary.userTokenTypes = Array.from(userTokenTypesSet);
        
        appendDetailedLog('Endpoint Query Results', {
          endpointUrl,
          endpointCount: endpoints.length,
          summary: endpointSummary,
          endpoints: endpoints
        }, `Found ${endpoints.length} endpoint(s) from ${endpointUrl}`);
      } else {
        logWarning('No endpoints returned from server', 'Endpoint Query');
        appendDetailedLog('Endpoint Query Results', { endpointUrl, endpoints: [] }, 'No endpoints found - server may be unreachable or endpoint URL incorrect');
      }
    } catch (err) {
      logError(err, 'Endpoint Query');
      throw err;
    }
    
    send('result-partial', { payload: { endpoints } });

    // Step 2: Capture baseline listening ports (before subscription)
    send('progress', { progress: 25, task: 'Recording listening ports (before)' });
    appendLog('Capturing baseline listening ports');
    
    let beforeListeners;
    try {
      beforeListeners = await getListeningPorts();
      const portCount = beforeListeners?.length || 0;
      appendLog(`Captured ${portCount} listening socket(s) before subscription`);
      
      const portSummary = {
        total: portCount,
        uniquePorts: [...new Set(beforeListeners.map(l => l.localPort))].filter(p => p),
        uniqueAddresses: [...new Set(beforeListeners.map(l => l.localAddress))].filter(a => a),
        protocols: [...new Set(beforeListeners.map(l => l.proto))].filter(p => p),
        pids: [...new Set(beforeListeners.map(l => l.pid))].filter(p => p)
      };
      
      appendDetailedLog('Baseline Listening Ports', {
        timestamp: new Date().toISOString(),
        summary: portSummary,
        listeners: beforeListeners
      }, `Baseline: ${portCount} listening socket(s) on ${portSummary.uniquePorts.length} unique port(s)`);
    } catch (err) {
      logError(err, 'Baseline Port Capture');
      beforeListeners = [];
      logWarning('Failed to capture baseline ports, continuing with empty array', 'Baseline Port Capture');
    }
    
    send('result-partial', { payload: { beforeListeners } });

    // Step 3: Create OPC-UA subscription (triggers callback listener ports)
    send('progress', { progress: 45, task: 'Creating subscription and monitored item' });
    appendLog('Creating subscription and monitored item');
    appendLog(`Target node: ${config.nodeId || 'ns=0;i=2258'}`);
    appendLog(`Publishing interval: ${config.publishingInterval || 250}ms`);
    
    let subscriptionResult;
    try {
      subscriptionResult = await createSubscriptionAndMonitor(config);
      
      if (subscriptionResult.success) {
        appendLog(`Subscription created successfully, monitored node: ${subscriptionResult.nodeMonitored}`);
        appendDetailedLog('Subscription Result', subscriptionResult, 'Subscription and monitored item created successfully');
      } else {
        logError(new Error(subscriptionResult.error || 'Subscription failed'), 'Subscription Creation');
        appendDetailedLog('Subscription Result', subscriptionResult, 'Subscription creation failed');
      }
    } catch (err) {
      logError(err, 'Subscription Creation');
      subscriptionResult = { success: false, error: String(err) };
      appendDetailedLog('Subscription Result', subscriptionResult, 'Exception during subscription creation');
    }
    
    send('result-partial', { payload: { subscriptionResult } });

    // Step 4: Capture listening ports after subscription (identify new callback listeners)
    send('progress', { progress: 65, task: 'Recording listening ports (after)' });
    appendLog('Capturing listening ports after subscription');
    
    let afterListeners;
    try {
      afterListeners = await getListeningPorts();
      const portCount = afterListeners?.length || 0;
      appendLog(`Captured ${portCount} listening socket(s) after subscription`);
      
      // Compare with baseline
      const baselinePorts = new Set((beforeListeners || []).map(l => `${l.localAddress}:${l.localPort}`));
      const afterPorts = new Set((afterListeners || []).map(l => `${l.localAddress}:${l.localPort}`));
      const newPorts = [...afterPorts].filter(p => !baselinePorts.has(p));
      const removedPorts = [...baselinePorts].filter(p => !afterPorts.has(p));
      
      const portSummary = {
        total: portCount,
        uniquePorts: [...new Set(afterListeners.map(l => l.localPort))].filter(p => p),
        uniqueAddresses: [...new Set(afterListeners.map(l => l.localAddress))].filter(a => a),
        protocols: [...new Set(afterListeners.map(l => l.proto))].filter(p => p),
        pids: [...new Set(afterListeners.map(l => l.pid))].filter(p => p),
        comparison: {
          newPorts: newPorts,
          removedPorts: removedPorts,
          netChange: portCount - (beforeListeners?.length || 0)
        }
      };
      
      appendDetailedLog('Post-Subscription Listening Ports', {
        timestamp: new Date().toISOString(),
        summary: portSummary,
        listeners: afterListeners,
        baselineComparison: {
          beforeCount: beforeListeners?.length || 0,
          afterCount: portCount,
          newPortsCount: newPorts.length,
          removedPortsCount: removedPorts.length
        }
      }, `After subscription: ${portCount} listening socket(s), ${newPorts.length} new port(s) detected`);
    } catch (err) {
      logError(err, 'Post-Subscription Port Capture');
      afterListeners = [];
      logWarning('Failed to capture post-subscription ports, continuing with empty array', 'Post-Subscription Port Capture');
    }
    
    send('result-partial', { payload: { afterListeners } });

    // Step 5: Monitor for incoming connections from server (callback attempts, 30s)
    send('progress', { progress: 75, task: 'Monitoring incoming connection attempts (30s)' });
    appendLog('Monitoring incoming connections from server');
    const serverIp = extractHostFromEndpoint(config.server) || null;
    const serverPort = config.port;
    appendLog(`Monitoring for connections from server IP: ${serverIp || 'Unknown'} (port: ${serverPort})`);
    appendLog('Monitoring duration: 30 seconds');
    
    let connections;
    try {
      connections = await monitorConnectionAttempts(serverIp, serverPort, 30 * 1000);
      const connCount = connections?.length || 0;
      appendLog(`Monitoring complete: ${connCount} connection attempt(s) detected`);
      
      if (connCount > 0) {
        const connSummary = {
          total: connCount,
          uniqueRemoteAddresses: [...new Set(connections.map(c => c.remoteAddress))].filter(a => a),
          uniqueLocalPorts: [...new Set(connections.map(c => c.localPort))].filter(p => p),
          uniqueStates: [...new Set(connections.map(c => c.state))].filter(s => s),
          uniquePids: [...new Set(connections.map(c => c.pid))].filter(p => p),
          timeRange: {
            first: connections[0]?.timestamp || null,
            last: connections[connCount - 1]?.timestamp || null
          }
        };
        
        appendDetailedLog('Incoming Connection Monitoring Results', {
          serverIp,
          serverPort,
          monitoringDuration: '30 seconds',
          summary: connSummary,
          connections: connections
        }, `Detected ${connCount} incoming connection attempt(s) from server IP ${serverIp}`);
      } else {
        appendDetailedLog('Incoming Connection Monitoring Results', {
          serverIp,
          serverPort,
          monitoringDuration: '30 seconds',
          connections: []
        }, `No incoming connections detected from server IP ${serverIp} - server may not be attempting callbacks or firewall may be blocking`);
      }
    } catch (err) {
      logError(err, 'Connection Monitoring');
      connections = [];
      logWarning('Failed to monitor connections, continuing with empty array', 'Connection Monitoring');
    }
    
    send('result-partial', { payload: { connections } });

    const final = { endpoints, beforeListeners, subscriptionResult, afterListeners, connections };
    
    appendLog('\n\n========== PROBE COMPLETION SUMMARY ==========', true);
    appendLog(`Probe completed at: ${new Date().toISOString()}`, true);
    appendLog(`Configuration: ${JSON.stringify(config)}`, true);
    appendLog(`Endpoints found: ${endpoints?.length || 0}`, true);
    appendLog(`Baseline listeners: ${beforeListeners?.length || 0}`, true);
    appendLog(`Post-subscription listeners: ${afterListeners?.length || 0}`, true);
    appendLog(`Subscription success: ${subscriptionResult?.success ? 'Yes' : 'No'}`, true);
    appendLog(`Incoming connections detected: ${connections?.length || 0}`, true);
    appendLog(`========== END PROBE COMPLETION SUMMARY ==========\n`, true);
    
    writeErrorSummary();
    appendDetailedLog('Complete Probe Results', final, 'Complete aggregated results from all probe steps');
    
    send('result-final', { payload: final });
    appendLog('Probe finished successfully');
    process.exit(0);
  } catch (err) {
    logError(err, 'Probe Execution');
    appendLog('\n\n========== PROBE FAILED ==========', true);
    appendLog(`Probe failed at: ${new Date().toISOString()}`, true);
    appendLog(`Configuration: ${JSON.stringify(config)}`, true);
    appendLog(`========== END PROBE FAILED ==========\n`, true);
    
    // Write error/warning summary
    writeErrorSummary();
    
    send('error', { error: String(err) });
    process.exit(1);
  }
});

const { OPCUAClient } = require('node-opcua');

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

// Normalizes endpoint to opc.tcp://host:port format (handles various input formats)
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

  return `opc.tcp://${server}:${port}`;
}

// Creates OPC-UA subscription to trigger callback listener ports
async function createSubscriptionAndMonitor(cfg) {
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
    await subscription.monitor(
      { nodeId: itemToMonitor, attributeId: 13 },
      { samplingInterval: cfg.publishingInterval || 250, discardOldest: true, queueSize: 10 },
      0
    );

    // Wait for callback listener ports to open
    await new Promise(resolve => setTimeout(resolve, 1500));

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

// Extracts hostname/IP from various endpoint URL formats
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

// Captures listening TCP ports using Windows netstat
function getListeningPorts() {
  return new Promise((resolve, reject) => {
    exec('netstat -ano', { windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      const lines = stdout.split(/\r?\n/).slice(4).filter(l => l.trim());
      const listeners = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
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

// Monitors for incoming TCP connections from server (callback attempts)
// Polls netstat every 2s for connections from serverIp
function monitorConnectionAttempts(serverIp, serverPort, durationMs) {
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
