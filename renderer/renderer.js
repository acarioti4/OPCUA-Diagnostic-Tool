/**
 * Renderer process - UI logic and event handling
 * Communication: renderer -> main -> worker -> main -> renderer
 */

const runBtn = document.getElementById('runBtn');
const cancelBtn = document.getElementById('cancelBtn');
const serverEl = document.getElementById('server');
const portEl = document.getElementById('port');
const nodeidEl = document.getElementById('nodeid');
const publishingEl = document.getElementById('publishing');
const progressFill = document.getElementById('progressFill');
const currentTask = document.getElementById('currentTask');
const progressPercentLabel = document.getElementById('progressPercent');
const resultsEl = document.getElementById('results');
const statusChip = document.getElementById('statusChip');
const themeToggle = document.getElementById('themeToggle');

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent || 0));
  progressFill.style.width = clamped + '%';
  progressPercentLabel.innerText = clamped + '%';
}

function setStatus(state) {
  statusChip.className = 'status-chip';
  if (state === 'running') {
    statusChip.classList.add('status-chip-running');
    statusChip.innerText = 'Running';
  } else if (state === 'complete') {
    statusChip.classList.add('status-chip-complete');
    statusChip.innerText = 'Complete';
  } else if (state === 'error') {
    statusChip.classList.add('status-chip-error');
    statusChip.innerText = 'Error';
  } else {
    statusChip.classList.add('status-chip-idle');
    statusChip.innerText = 'Idle';
  }
}

function applyTheme(theme) {
  const body = document.body;
  if (theme === 'dark') {
    body.classList.remove('theme-light');
    body.classList.add('theme-dark');
  } else {
    body.classList.remove('theme-dark');
    body.classList.add('theme-light');
  }
}

function toggleTheme() {
  const isDark = document.body.classList.contains('theme-dark');
  const newTheme = isDark ? 'light' : 'dark';
  applyTheme(newTheme);
  try {
    localStorage.setItem('opcuaTheme', newTheme);
  } catch (_) {}
}

themeToggle.addEventListener('click', toggleTheme);

(function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem('opcuaTheme');
  } catch (_) {}
  if (stored === 'light' || stored === 'dark') {
    applyTheme(stored);
  } else {
    const prefersDark = window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  }
})();

function clearResults() {
  resultsEl.innerHTML = '<div id="resultsEmpty">No results yet.</div>';
}

function addLogEntry({ title, message, severity = 'info' }) {
  const empty = document.getElementById('resultsEmpty');
  if (empty) empty.remove();

  // Create the log entry container with severity-based styling
  const container = document.createElement('div');
  container.className = 'log-entry log-entry--' + severity;

  // Create header with title and timestamp
  const header = document.createElement('div');
  header.className = 'log-entry-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'log-entry-title';
  titleEl.textContent = title;

  const timeEl = document.createElement('div');
  timeEl.className = 'log-entry-time';
  timeEl.textContent = new Date().toLocaleTimeString();

  header.appendChild(titleEl);
  header.appendChild(timeEl);

  // Create message body
  const body = document.createElement('div');
  body.className = 'log-entry-body';
  body.textContent = message;

  container.appendChild(header);
  container.appendChild(body);

  // Add to results container and auto-scroll to bottom
  resultsEl.appendChild(container);
  resultsEl.scrollTop = resultsEl.scrollHeight;
}

// Result summarization: converts raw diagnostic data into human-readable summaries
let baselineListeners = null;
let afterListeners = null;

function summarizeEndpoints(endpoints) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return {
      severity: 'error',
      text: 'The server did not return any OPC UA endpoints. This usually means the endpoint URL or port is wrong, or the server refused the connection.'
    };
  }

  const total = endpoints.length;
  let noneCount = 0;
  let modernCount = 0;
  let legacyCount = 0;
  const policies = new Set();

  for (const e of endpoints) {
    const uri = (e.securityPolicyUri || '').toString();
    if (!uri) continue;
    const lower = uri.toLowerCase();
    policies.add(uri);
    if (lower.includes('none')) {
      noneCount++;
    } else if (lower.includes('aes')) {
      modernCount++;
    } else if (lower.includes('basic128') || lower.includes('basic256')) {
      legacyCount++;
    }
  }

  const policyList = Array.from(policies);
  let parts = [];
  parts.push(`The server advertised ${total} OPC UA endpoint(s).`);

  if (noneCount > 0) {
    parts.push(`${noneCount} endpoint(s) use no encryption (SecurityPolicy.None).`);
  }
  if (legacyCount > 0) {
    parts.push(`${legacyCount} endpoint(s) use legacy RSA-based security policies (Basic128/256).`);
  }
  if (modernCount > 0) {
    parts.push(`${modernCount} endpoint(s) use modern AES-based security policies.`);
  }
  if (policyList.length > 0) {
    parts.push(`Security policies seen: ${policyList.join(', ')}.`);
  }

  let severity = 'success';
  if (modernCount === 0 && noneCount > 0 && legacyCount === 0) {
    severity = 'warn';
  }

  return { severity, text: parts.join(' ') };
}

function getUniquePorts(listeners) {
  const ports = new Set();
  for (const l of listeners || []) {
    if (l.localPort) ports.add(String(l.localPort));
  }
  return Array.from(ports);
}

function summarizeBeforeListeners(before) {
  baselineListeners = Array.isArray(before) ? before : [];
  const ports = getUniquePorts(baselineListeners);

  if (baselineListeners.length === 0) {
    return {
      severity: 'info',
      text: 'Before creating a subscription, no listening TCP sockets were captured for this process. This is the baseline used for comparison.'
    };
  }

  let portText;
  if (ports.length === 0) {
    portText = 'no specific ports could be parsed.';
  } else if (ports.length <= 5) {
    portText = `ports ${ports.join(', ')}.`;
  } else {
    portText = `ports ${ports.slice(0, 5).join(', ')} and additional ports.`;
  }

  return {
    severity: 'info',
    text: `Before the subscription, the tool saw ${baselineListeners.length} listening TCP socket(s) on ${portText}`
  };
}

function summarizeSubscriptionResult(sub) {
  if (!sub) {
    return {
      severity: 'warn',
      text: 'No information was returned about the subscription attempt.'
    };
  }

  if (sub.success) {
    const node = sub.nodeMonitored || 'the default status node';
    return {
      severity: 'success',
      text: `The tool successfully created a subscription and monitored ${node}. This confirms the server accepted the subscription on the selected endpoint.`
    };
  } else {
    const err = sub.error ? shortenError(sub.error) : 'an unspecified error occurred.';
    return {
      severity: 'error',
      text: `The tool could not maintain a subscription. The server likely rejected the monitored item or closed the session early. Details: ${err}`
    };
  }
}

function summarizeAfterListeners(after) {
  afterListeners = Array.isArray(after) ? after : [];
  const portsAfter = getUniquePorts(afterListeners);

  if (!baselineListeners) {
    if (afterListeners.length === 0) {
      return {
        severity: 'info',
        text: 'After the subscription step, no listening TCP sockets were captured.'
      };
    }
    let portText;
    if (portsAfter.length === 0) {
      portText = 'no specific ports could be parsed.';
    } else if (portsAfter.length <= 5) {
      portText = `ports ${portsAfter.join(', ')}.`;
    } else {
      portText = `ports ${portsAfter.slice(0, 5).join(', ')} and additional ports.`;
    }
    return {
      severity: 'info',
      text: `After the subscription, the tool saw ${afterListeners.length} listening TCP socket(s) on ${portText}`
    };
  }

  const portsBefore = new Set(getUniquePorts(baselineListeners));
  const newPorts = portsAfter.filter((p) => !portsBefore.has(p));

  if (afterListeners.length === 0) {
    return {
      severity: 'warn',
      text: 'After the subscription, no listening TCP sockets were captured. This suggests the client did not keep a separate callback listener open.'
    };
  }

  if (newPorts.length === 0) {
    return {
      severity: 'info',
      text: 'The set of listening ports did not change after creating the subscription. The OPC UA client likely reused existing ports for callbacks.'
    };
  }

  let text;
  if (newPorts.length <= 5) {
    text = `New listening port(s) appeared after the subscription: ${newPorts.join(', ')}.`;
  } else {
    text = `Several new listening ports appeared after the subscription, including ${newPorts.slice(0, 5).join(', ')}.`;
  }

  return {
    severity: 'info',
    text: `After creating the subscription, the tool saw ${afterListeners.length} listening TCP socket(s). ${text}`
  };
}

function summarizeConnections(connections) {
  if (!Array.isArray(connections) || connections.length === 0) {
    return {
      severity: 'warn',
      text: 'No incoming TCP connections from the server’s IP were observed during the monitoring window. This may mean the server is not attempting callbacks, cannot reach this machine, or a firewall is blocking the traffic.'
    };
  }

  const total = connections.length;
  const last = connections[connections.length - 1];

  const src = (last.remoteAddress || last.srcAddress || 'server');
  const srcPort = (last.remotePort || last.srcPort || '');
  const dst = (last.localAddress || last.dstAddress || 'this machine');
  const dstPort = (last.localPort || last.dstPort || '');
  const state = last.state || (last.synOnly ? 'SYN' : 'unknown');

  const details = `One example connection was from ${src}${srcPort ? ':' + srcPort : ''} to ${dst}${dstPort ? ':' + dstPort : ''} with state "${state}".`;

  return {
    severity: 'success',
    text: `The tool observed ${total} incoming TCP connection attempt(s) from the server’s IP during the monitoring window. ${details}`
  };
}

function shortenError(text) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length > 220) return s.slice(0, 217) + '…';
  return s;
}

runBtn.addEventListener('click', () => {
  let port = parseInt(portEl.value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    port = 4840;
  }

  const publishing = parseInt(publishingEl.value, 10);
  const publishingInterval = Number.isFinite(publishing) && publishing > 0
    ? publishing
    : 250;

  let server = serverEl.value.trim();
  if (server.toLowerCase().startsWith('opc.tcp://')) {
    server = server.slice('opc.tcp://'.length);
  }

  const cfg = {
    server,
    port,
    nodeId: nodeidEl.value || 'ns=0;i=2258',
    publishingInterval
  };

  runBtn.disabled = true;
  baselineListeners = null;
  afterListeners = null;
  setProgress(5);
  currentTask.innerText = 'Starting probe…';
  setStatus('running');

  clearResults();
  addLogEntry({
    title: 'Probe',
    severity: 'info',
    message: 'Starting the OPC UA endpoint probe with the current configuration.'
  });

  window.electronAPI.runProbe(cfg);
});

cancelBtn.addEventListener('click', () => {
  window.electronAPI.cancelProbe();
  addLogEntry({
    title: 'Probe',
    severity: 'warn',
    message: 'The probe was cancelled by the user.'
  });
  runBtn.disabled = false;
  setProgress(0);
  currentTask.innerText = 'Idle';
  setStatus('idle');
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') runBtn.click();
});

window.electronAPI.onProbeEvent((msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'progress':
      currentTask.innerText = msg.task || 'Working...';
      setProgress(msg.progress || 0);
      break;

    case 'result-partial':
      handlePartialResult(msg.payload);
      break;

    case 'result-final':
      handleFinalResult();
      runBtn.disabled = false;
      setProgress(100);
      currentTask.innerText = 'Complete';
      setStatus('complete');
      break;

    case 'log':
      if (msg.message) {
        addLogEntry({
          title: 'Worker log',
          severity: 'info',
          message: msg.message
        });
      }
      break;

    case 'finished':
      addLogEntry({
        title: 'Worker',
        severity: 'worker',
        message: 'The worker process has finished.'
      });
      if (progressPercentLabel.innerText !== '100%') {
        setStatus('idle');
      }
      runBtn.disabled = false;
      break;

    case 'error':
      handleErrorMessage(msg.error);
      runBtn.disabled = false;
      currentTask.innerText = 'Error';
      setStatus('error');
      break;
  }
});

function handlePartialResult(payload) {
  if (!payload || typeof payload !== 'object') return;

  // Display endpoint security analysis
  if (payload.endpoints) {
    const { severity, text } = summarizeEndpoints(payload.endpoints);
    addLogEntry({ title: 'Endpoint Security', severity, message: text });
  }

  // Display baseline listening ports (before subscription)
  if (payload.beforeListeners) {
    const { severity, text } = summarizeBeforeListeners(payload.beforeListeners);
    addLogEntry({ title: 'Baseline Listeners', severity, message: text });
  }

  // Display subscription creation result
  if (payload.subscriptionResult) {
    const { severity, text } = summarizeSubscriptionResult(payload.subscriptionResult);
    addLogEntry({ title: 'Subscription', severity, message: text });
  }

  // Display listening ports after subscription (for comparison)
  if (payload.afterListeners) {
    const { severity, text } = summarizeAfterListeners(payload.afterListeners);
    addLogEntry({ title: 'Post-Subscription Listeners', severity, message: text });
  }

  // Display server callback connection attempts
  if (payload.connections) {
    const { severity, text } = summarizeConnections(payload.connections);
    addLogEntry({ title: 'Server Callbacks', severity, message: text });
  }
}

function handleErrorMessage(error) {
  const msg = error ? shortenError(error) : 'An unknown error occurred in the worker.';
  addLogEntry({
    title: 'Error',
    severity: 'error',
    message: msg
  });
}

function handleFinalResult() {
  addLogEntry({
    title: 'Probe',
    severity: 'success',
    message: 'The probe has completed. Review the entries above for detailed results.'
  });
}
