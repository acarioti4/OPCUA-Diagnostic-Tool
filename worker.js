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

  // --- Utility helpers for formatted log output ---

  function formatTable(headers, rows, indent = '    ') {
    const lines = [];
    const headerLine = headers.map(h => String(h.label).padEnd(h.width)).join('  ');
    const separatorLine = headers.map(h => '-'.repeat(h.width)).join('  ');
    lines.push(indent + headerLine);
    lines.push(indent + separatorLine);
    for (const row of rows) {
      const cells = headers.map((h, i) => {
        const val = String(row[i] ?? '');
        return val.length > h.width ? val.slice(0, h.width - 2) + '..' : val.padEnd(h.width);
      });
      lines.push(indent + cells.join('  '));
    }
    return lines;
  }

  function securityModeToString(mode) {
    if (typeof mode === 'string') return mode;
    const map = { 0: 'Invalid', 1: 'None', 2: 'Sign', 3: 'SignAndEncrypt' };
    return map[mode] ?? String(mode);
  }

  function tokenTypeToString(type) {
    if (typeof type === 'string') return type;
    const map = { 0: 'Anonymous', 1: 'UserName', 2: 'Certificate', 3: 'IssuedToken' };
    return map[type] ?? String(type);
  }

  function shortenPolicyUri(uri) {
    if (!uri) return 'Unknown';
    const idx = uri.lastIndexOf('#');
    return idx >= 0 ? uri.slice(idx + 1) : uri;
  }

  // --- Section formatters (file-only output) ---

  function formatProbeConfig(cfg) {
    appendLog('', true);
    appendLog('========== Probe Configuration ==========', true);
    appendLog(`  Server:               ${cfg.server || 'N/A'}`, true);
    appendLog(`  Port:                 ${cfg.port || 'N/A'}`, true);
    appendLog(`  Node ID:              ${cfg.nodeId || 'ns=0;i=2258'}`, true);
    appendLog(`  Publishing Interval:  ${cfg.publishingInterval || 250} ms`, true);
    appendLog('========== End Probe Configuration ==========', true);
    appendLog('', true);
  }

  function formatEndpointResults(endpointUrl, endpoints, endpointSummary) {
    appendLog('', true);
    appendLog('========== Endpoint Query Results ==========', true);
    appendLog(`  Endpoint URL:  ${endpointUrl}`, true);
    appendLog(`  Total Found:   ${endpoints?.length || 0}`, true);

    if (!endpoints || endpoints.length === 0) {
      appendLog('', true);
      appendLog('  Note: No endpoints found - server may be unreachable or endpoint URL incorrect', true);
      appendLog('========== End Endpoint Query Results ==========', true);
      appendLog('', true);
      return;
    }

    // Security summary
    if (endpointSummary) {
      appendLog('', true);
      appendLog('  Security Summary:', true);
      if (endpointSummary.securityPolicies && Object.keys(endpointSummary.securityPolicies).length > 0) {
        appendLog('    Policies:', true);
        const maxLen = Math.max(...Object.keys(endpointSummary.securityPolicies).map(k => shortenPolicyUri(k).length));
        for (const [uri, count] of Object.entries(endpointSummary.securityPolicies)) {
          const name = shortenPolicyUri(uri);
          const dots = '.'.repeat(Math.max(2, maxLen - name.length + 3));
          appendLog(`      ${name} ${dots} ${count} endpoint(s)`, true);
        }
      }
      if (endpointSummary.securityModes && Object.keys(endpointSummary.securityModes).length > 0) {
        appendLog('    Modes:', true);
        const maxLen = Math.max(...Object.keys(endpointSummary.securityModes).map(k => securityModeToString(k).length));
        for (const [mode, count] of Object.entries(endpointSummary.securityModes)) {
          const name = securityModeToString(mode);
          const dots = '.'.repeat(Math.max(2, maxLen - name.length + 3));
          appendLog(`      ${name} ${dots} ${count} endpoint(s)`, true);
        }
      }
      if (endpointSummary.userTokenTypes && endpointSummary.userTokenTypes.length > 0) {
        appendLog(`    User Token Types: ${endpointSummary.userTokenTypes.map(t => tokenTypeToString(t)).join(', ')}`, true);
      }
    }

    // Endpoint table
    appendLog('', true);
    appendLog('  Endpoint Details:', true);
    const headers = [
      { label: '#', width: 3 },
      { label: 'URL', width: 31 },
      { label: 'Security Policy', width: 22 },
      { label: 'Mode', width: 16 },
      { label: 'Tokens', width: 24 }
    ];
    const rows = endpoints.map((ep, i) => [
      String(i + 1),
      ep.endpointUrl || '',
      shortenPolicyUri(ep.securityPolicyUri),
      securityModeToString(ep.securityMode),
      (ep.userIdentityTokens || []).map(t => tokenTypeToString(t)).join(', ')
    ]);
    for (const line of formatTable(headers, rows)) {
      appendLog(line, true);
    }

    appendLog('========== End Endpoint Query Results ==========', true);
    appendLog('', true);
  }

  function formatListeningPorts(sectionTitle, listeners, portSummary) {
    appendLog('', true);
    appendLog(`========== ${sectionTitle} ==========`, true);
    appendLog(`  Captured At:       ${new Date().toISOString()}`, true);
    appendLog(`  Total Sockets:     ${portSummary.total}`, true);
    appendLog(`  Unique Ports:      ${portSummary.uniquePorts.length}`, true);
    const addrPreview = portSummary.uniqueAddresses.slice(0, 5).join(', ');
    const addrExtra = portSummary.uniqueAddresses.length > 5 ? ', ...' : '';
    appendLog(`  Unique Addresses:  ${portSummary.uniqueAddresses.length}  (${addrPreview}${addrExtra})`, true);
    appendLog(`  Protocols:         ${portSummary.protocols.join(', ') || 'N/A'}`, true);
    const pidPreview = portSummary.pids.slice(0, 10).join(', ');
    const pidExtra = portSummary.pids.length > 10 ? ', ...' : '';
    appendLog(`  PIDs:              ${pidPreview}${pidExtra}`, true);

    appendLog('', true);
    appendLog('  Listening Sockets:', true);
    const headers = [
      { label: 'Proto', width: 5 },
      { label: 'Local Address', width: 21 },
      { label: 'Port', width: 6 },
      { label: 'PID', width: 6 }
    ];
    const rows = (listeners || []).map(l => [
      l.proto || '',
      l.localAddress || '',
      l.localPort || '',
      l.pid || ''
    ]);
    for (const line of formatTable(headers, rows)) {
      appendLog(line, true);
    }

    // Don't close the section here if port comparison will follow
    return sectionTitle; // caller decides when to close
  }

  function closeSection(sectionTitle) {
    appendLog(`========== End ${sectionTitle} ==========`, true);
    appendLog('', true);
  }

  function formatPortComparison(beforeCount, afterCount, newPorts, removedPorts) {
    appendLog('', true);
    appendLog('  Port Comparison (Before vs After Subscription):', true);
    const change = afterCount - beforeCount;
    const changeStr = change >= 0 ? `+${change}` : String(change);
    appendLog(`    Before:  ${beforeCount} listening socket(s)`, true);
    appendLog(`    After:   ${afterCount} listening socket(s)`, true);
    appendLog(`    Change:  ${changeStr}`, true);

    appendLog('', true);
    appendLog(`    New Ports Detected (${newPorts.length}):`, true);
    if (newPorts.length > 0) {
      for (const p of newPorts) {
        appendLog(`      >> ${p}`, true);
      }
    } else {
      appendLog('      (none)', true);
    }

    appendLog('', true);
    appendLog(`    Removed Ports (${removedPorts.length}):`, true);
    if (removedPorts.length > 0) {
      for (const p of removedPorts) {
        appendLog(`      << ${p}`, true);
      }
    } else {
      appendLog('      (none)', true);
    }
  }

  function formatSubscriptionResult(result) {
    appendLog('', true);
    appendLog('========== Subscription Result ==========', true);
    if (result.success) {
      appendLog('  Status:          SUCCESS', true);
      appendLog(`  Node Monitored:  ${result.nodeMonitored || 'N/A'}`, true);
    } else {
      appendLog('  Status:  FAILED', true);
      appendLog(`  Error:   ${result.error || 'Unknown error'}`, true);
    }
    appendLog('========== End Subscription Result ==========', true);
    appendLog('', true);
  }

  function formatConnectionResults(serverIp, serverPort, connections, connSummary) {
    appendLog('', true);
    appendLog('========== Incoming Connection Monitoring Results ==========', true);
    appendLog(`  Server IP:           ${serverIp || 'Unknown'}`, true);
    appendLog(`  Server Port:         ${serverPort || 'Unknown'}`, true);
    appendLog('  Monitoring Duration: 30 seconds', true);
    appendLog(`  Connections Found:   ${connections?.length || 0}`, true);

    if (!connections || connections.length === 0) {
      appendLog('', true);
      appendLog(`  Note: No incoming connections detected from server IP ${serverIp || 'Unknown'}`, true);
      appendLog('        Server may not be attempting callbacks, or a firewall may be blocking traffic.', true);
      appendLog('========== End Incoming Connection Monitoring Results ==========', true);
      appendLog('', true);
      return;
    }

    // Connection summary
    if (connSummary) {
      appendLog('', true);
      appendLog('  Connection Summary:', true);
      const raPreview = (connSummary.uniqueRemoteAddresses || []).slice(0, 5).join(', ');
      appendLog(`    Unique Remote Addresses:  ${connSummary.uniqueRemoteAddresses?.length || 0}  (${raPreview})`, true);
      const lpPreview = (connSummary.uniqueLocalPorts || []).slice(0, 10).join(', ');
      appendLog(`    Unique Local Ports:       ${connSummary.uniqueLocalPorts?.length || 0}  (${lpPreview})`, true);
      appendLog(`    Connection States:        ${(connSummary.uniqueStates || []).join(', ') || 'N/A'}`, true);
      appendLog(`    PIDs:                     ${(connSummary.uniquePids || []).join(', ') || 'N/A'}`, true);
      if (connSummary.timeRange) {
        const first = connSummary.timeRange.first ? connSummary.timeRange.first.replace(/.*T/, '').replace(/\.\d+Z$/, '') : '?';
        const last = connSummary.timeRange.last ? connSummary.timeRange.last.replace(/.*T/, '').replace(/\.\d+Z$/, '') : '?';
        appendLog(`    Time Range:               ${first} - ${last}`, true);
      }
    }

    // Connection table
    appendLog('', true);
    appendLog('  Connection Details:', true);
    const headers = [
      { label: '#', width: 3 },
      { label: 'Time', width: 8 },
      { label: 'Proto', width: 5 },
      { label: 'Local', width: 21 },
      { label: 'Remote', width: 21 },
      { label: 'State', width: 13 },
      { label: 'PID', width: 6 }
    ];
    const rows = connections.map((c, i) => {
      const time = c.timestamp ? c.timestamp.replace(/.*T/, '').replace(/\.\d+Z$/, '') : '';
      return [
        String(i + 1),
        time,
        c.proto || '',
        `${c.localAddress || ''}:${c.localPort || ''}`,
        `${c.remoteAddress || ''}:${c.remotePort || ''}`,
        c.state || '',
        c.pid || ''
      ];
    });
    for (const line of formatTable(headers, rows)) {
      appendLog(line, true);
    }

    appendLog('========== End Incoming Connection Monitoring Results ==========', true);
    appendLog('', true);
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
  formatProbeConfig(config);

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
        
        formatEndpointResults(endpointUrl, endpoints, endpointSummary);
      } else {
        logWarning('No endpoints returned from server', 'Endpoint Query');
        formatEndpointResults(endpointUrl, [], null);
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
      
      formatListeningPorts('Baseline Listening Ports', beforeListeners, portSummary);
      closeSection('Baseline Listening Ports');
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
        formatSubscriptionResult(subscriptionResult);
      } else {
        logError(new Error(subscriptionResult.error || 'Subscription failed'), 'Subscription Creation');
        formatSubscriptionResult(subscriptionResult);
      }
    } catch (err) {
      logError(err, 'Subscription Creation');
      subscriptionResult = { success: false, error: String(err) };
      formatSubscriptionResult(subscriptionResult);
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
      
      formatListeningPorts('Post-Subscription Listening Ports', afterListeners, portSummary);
      formatPortComparison(beforeListeners?.length || 0, portCount, newPorts, removedPorts);
      closeSection('Post-Subscription Listening Ports');
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
        
        formatConnectionResults(serverIp, serverPort, connections, connSummary);
      } else {
        formatConnectionResults(serverIp, serverPort, [], null);
      }
    } catch (err) {
      logError(err, 'Connection Monitoring');
      connections = [];
      logWarning('Failed to monitor connections, continuing with empty array', 'Connection Monitoring');
    }
    
    send('result-partial', { payload: { connections } });

    const final = { endpoints, beforeListeners, subscriptionResult, afterListeners, connections };
    
    appendLog('', true);
    appendLog('========== PROBE COMPLETION SUMMARY ==========', true);
    appendLog(`  Probe Completed At:          ${new Date().toISOString()}`, true);
    appendLog(`  Server:                      ${config.server || 'N/A'}`, true);
    appendLog(`  Port:                        ${config.port || 'N/A'}`, true);
    appendLog(`  Node ID:                     ${config.nodeId || 'ns=0;i=2258'}`, true);
    appendLog(`  Publishing Interval:         ${config.publishingInterval || 250} ms`, true);
    appendLog(`  Endpoints Found:             ${endpoints?.length || 0}`, true);
    appendLog(`  Baseline Listeners:          ${beforeListeners?.length || 0}`, true);
    appendLog(`  Post-Subscription Listeners: ${afterListeners?.length || 0}`, true);
    appendLog(`  Subscription Success:        ${subscriptionResult?.success ? 'Yes' : 'No'}`, true);
    appendLog(`  Incoming Connections:         ${connections?.length || 0}`, true);
    appendLog('========== END PROBE COMPLETION SUMMARY ==========', true);
    appendLog('', true);
    
    writeErrorSummary();

    send('result-final', { payload: final });
    appendLog('Probe finished successfully');
    process.exit(0);
  } catch (err) {
    logError(err, 'Probe Execution');
    appendLog('', true);
    appendLog('========== PROBE FAILED ==========', true);
    appendLog(`  Failed At:           ${new Date().toISOString()}`, true);
    appendLog(`  Server:              ${config.server || 'N/A'}`, true);
    appendLog(`  Port:                ${config.port || 'N/A'}`, true);
    appendLog(`  Node ID:             ${config.nodeId || 'ns=0;i=2258'}`, true);
    appendLog(`  Publishing Interval: ${config.publishingInterval || 250} ms`, true);
    appendLog('========== END PROBE FAILED ==========', true);
    appendLog('', true);
    
    // Write error/warning summary
    writeErrorSummary();
    
    send('error', { error: String(err) });
    process.exit(1);
  }
});

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
    const monitoredItem = await subscription.monitor(
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
