# OPC-UA Endpoint Diagnostic

OPC-UA Endpoint Diagnostic is a Windows desktop tool (built with Electron and Node.js) that helps you verify and troubleshoot connectivity between an OPC UA client and an OPC UA server endpoint.

The app runs a structured “probe” against an OPC UA server:

- Connects as an OPC UA client to the endpoint you specify
- Discovers available endpoints and their security settings
- Creates a subscription and monitored item to trigger server→client traffic
- Captures local listening ports before and after the subscription
- Monitors for incoming TCP connections from the server’s IP address
- Produces a human-readable summary and a detailed log file for analysis

It is designed for situations where a basic “client can connect” check is not enough and you need to understand whether callbacks and subscription traffic can actually traverse the network.

---

## Features

- **Endpoint Security Inspection**
  - Connects to an OPC UA endpoint (opc.tcp)
  - Lists discovered endpoints and their security policies
  - Distinguishes between:
    - No security (SecurityPolicy.None)
    - Legacy RSA-based policies (Basic128/256)
    - Modern AES-based policies

- **Subscription & Monitored Item Test**
  - Creates a subscription with a configurable publishing interval (default: 250ms)
  - Monitors a specified NodeId (default: `ns=0;i=2258`, ServerStatus_CurrentTime)
  - Verifies that the server accepts subscriptions on the selected endpoint

- **Listening Port Comparison**
  - Captures the set of listening TCP sockets before the subscription
  - Captures them again after the subscription
  - Highlights new ports that appear after the subscription, which are likely used for callbacks

- **Connection Attempt Monitoring**
  - Uses `netstat` polling to watch for incoming connections from the server’s IP
  - Records address, ports, state, and timestamp for each observed attempt
  - Helps determine whether the server can actually reach back to the client machine

- **Human-Readable Output**
  - The UI shows a step-by-step narrative:
    - What was tested
    - What happened
    - Why it matters for connectivity
  - A detailed log file is written to `%APPDATA%\opcua-endpoint-diagnostics\logs` for deep-dive troubleshooting
    - Default path: `C:\Users\<Username>\AppData\Roaming\opcua-endpoint-diagnostics\logs`

---

## How It Works (High-Level)

When you click **“Run Callback Path Probe”**, the app:

1. **Connects to the OPC UA server**
   - Uses `node-opcua` as the client library.
   - Connects to the endpoint you provide (e.g. `opc.tcp://hostname:4840`).

2. **Discovers endpoints and security**
   - Calls `getEndpoints()` on the server.
   - Summarizes which security policies are offered and how many endpoints are using each.

3. **Captures baseline listening ports**
   - Runs `netstat -ano` to capture TCP sockets in LISTEN state.
   - Stores this as the “before subscription” baseline.

4. **Creates a subscription and monitored item**
   - Uses the configured publishing interval (default 250ms) and NodeId (default `ns=0;i=2258`).
   - Connects to the specified port (default 4840).
   - Waits briefly to allow any callback-related sockets to be opened by the OPC UA stack.

5. **Captures post-subscription listening ports**
   - Runs `netstat -ano` again.
   - Compares against the baseline to see if any new listening ports appeared.

6. **Monitors incoming connections from the server**
   - Polls `netstat` every 2 seconds for 30 seconds (15 polls).
   - Filters entries by the server’s IP address.
   - Records any incoming connection attempts (including state and ports).

7. **Summarizes the results**
   - The renderer converts raw data into plain-English messages:
     - Endpoint security overview
     - Baseline vs. post-subscription listeners
     - Subscription success/failure
     - Presence or absence of incoming connection attempts
   - A final summary line indicates that the probe has completed.

---

## Architecture

The application uses a simple, robust separation of concerns:

- **Electron Main Process (`main.js`)**
  - Creates the main browser window.
  - Spawns a separate Node.js worker process for each probe.
  - Forwards messages between the renderer and the worker via IPC.

- **Renderer (UI)**
  - HTML/CSS/JS front-end displayed in the Electron window.
  - Handles:
    - Form inputs (server endpoint, port, NodeId, publishing interval)
    - Running and canceling probes (keyboard shortcut: **Ctrl+Enter** to start)
    - Progress bar and current task status
    - Live, color-coded output for each phase (blue=info, green=success, yellow=warn, red=error)
    - Light/dark theme toggle (preference saved across sessions)
  - Communicates with the main process via an IPC bridge in `preload.js`.

- **Worker (`worker.js`)**
  - Runs all probe logic in a background process so the UI stays responsive.
  - Uses:
    - `node-opcua` for endpoint discovery and subscription
    - `netstat` (via `child_process.exec`) for listening port and connection monitoring
  - Streams partial results back to the renderer (endpoints, port snapshots, connection attempts).
  - Writes a structured log file to the application’s data directory.

---

## Requirements

- **Operating System:** Windows 10 or later (netstat-based monitoring is Windows-oriented)
- **Node.js:** v18 or newer (only required for running from source)
- **Internet / Network:** Access to the OPC UA server you want to diagnose

---

## Installation (From Source)

1. **Clone or download** this repository.

2. Install dependencies:

   ```bash
   npm install
   ```

3. Run the application:

   ```bash
   npm start
   ```

4. *(Optional)* Build a distributable package:

   ```bash
   npm run build
   ```
