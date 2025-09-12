/**
 * Cloudflare Worker with Durable Object to replicate the Python FastAPI app.
 *
 * How it works:
 * 1. The main worker acts as a router.
 *    - It serves the admin HTML page on '/'.
 *    - It forwards all other requests (API calls, WebSocket upgrades) to a single
 *      Durable Object instance called 'TaskRoom'.
 *
 * 2. The 'TaskRoom' Durable Object is the stateful core.
 *    - It maintains the list of pending tasks, similar to the `tasks` dict in Python.
 *    - It manages all connected WebSocket clients, similar to the `clients` set.
 *    - When a request comes to `:streamGenerateContent`, it creates a task, stores
 *      it, and broadcasts it to all WebSocket clients. It holds the connection open
 *      by returning a streaming response.
 *    - When a human submits a reply to `/return/:taskId`, the Durable Object finds
 *      the corresponding waiting stream, pushes the reply data into it, and closes it.
 */

// The Durable Object class that holds the state.
export class TaskRoom {
  constructor(state, env) {
    this.state = state;
    // Using in-memory storage for simplicity, just like the Python app.
    // For persistence across DO restarts, you would use this.state.storage.
    this.tasks = new Map(); // Stores { rawRequest, controller, timeoutId }
    this.clients = new Set(); // Stores connected WebSocket clients
  }

  // Helper to format a chunk in Gemini API style
  createGeminiChunk(text = "", finishReason = null) {
    const chunk = {
      candidates: [{
        content: { parts: [{ text }], role: "model" },
        index: 0,
      }],
    };
    if (finishReason) {
      chunk.candidates[0].finishReason = finishReason;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  // Helper to broadcast a message to all connected WebSocket clients
  broadcast(message) {
    const serializedMessage = JSON.stringify(message);
    // Create a copy of clients to avoid issues if a client disconnects during iteration
    [...this.clients].forEach(client => {
      try {
        client.send(serializedMessage);
      } catch (e) {
        console.error(`Failed to send to client: ${e}`);
        // The webSocketClose handler will ultimately remove the client
        this.clients.delete(client);
      }
    });
  }

  // Handle HTTP requests forwarded to the Durable Object.
  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade requests
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      await this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // API endpoint for AI clients to stream content
    if (url.pathname.includes(':streamGenerateContent') && request.method === 'POST') {
      return this.handleStreamRequest(request);
    }

    // API endpoint for the admin panel to submit a reply
    if (url.pathname.startsWith('/return/') && request.method === 'POST') {
      return this.handleReturnResponse(request, url);
    }
    
    // API endpoint for the admin panel to get the initial list of tasks
    if (url.pathname === '/tasks' && request.method === 'GET') {
      return this.handleGetTasks();
    }

    return new Response('Not Found', { status: 404 });
  }

  // Handles new streaming requests from AI clients
  async handleStreamRequest(request) {
    let rawRequestBody;
    try {
      rawRequestBody = await request.text();
    } catch (e) {
      rawRequestBody = "[Error reading request body]";
    }

    if (!rawRequestBody.trim()) {
      rawRequestBody = "[Client sent an empty request body]";
    }

    const taskId = crypto.randomUUID().replace(/-/g, '');
    
    // Use a TransformStream to hold the connection open and send data later.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const controller = {
      enqueue: (chunk) => writer.write(new TextEncoder().encode(chunk)),
      close: () => writer.close(),
    };

    const timeoutId = setTimeout(() => {
        const task = this.tasks.get(taskId);
        if (task) {
            console.log(`Task ${taskId} timed out.`);
            const timeoutMessage = this.createGeminiChunk("[Waiting for manual reply timed out]", "ERROR");
            task.controller.enqueue(timeoutMessage);
            task.controller.close();
            this.tasks.delete(taskId);
        }
    }, 600 * 1000); // 600 seconds timeout

    this.tasks.set(taskId, { rawRequest: rawRequestBody, controller, timeoutId });

    // Broadcast the new task to all admin clients
    this.broadcast({
      type: 'new_task',
      task_id: taskId,
      raw_request: rawRequestBody,
    });

    // Return the readable side of the stream immediately.
    // The connection will stay open until the controller/writer is closed.
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Handles the reply submission from the admin panel
  async handleReturnResponse(request, url) {
    const taskId = url.pathname.split('/')[2];
    const task = this.tasks.get(taskId);

    if (!task) {
      return new Response(JSON.stringify({ status: 'error', message: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Clear the timeout since we received a response
    clearTimeout(task.timeoutId);

    const { reply } = await request.json();

    if (reply && reply.trim()) {
      const chunkSize = 256;
      const chunks = [];
      for (let i = 0; i < reply.length; i += chunkSize) {
        chunks.push(reply.substring(i, i + chunkSize));
      }

      chunks.forEach((chunkText, i) => {
        const isLastChunk = i === chunks.length - 1;
        const finishReason = isLastChunk ? "STOP" : null;
        task.controller.enqueue(this.createGeminiChunk(chunkText, finishReason));
      });
    } else {
      task.controller.enqueue(this.createGeminiChunk("[No reply content]", "STOP"));
    }
    
    task.controller.close();
    this.tasks.delete(taskId);

    this.broadcast({ type: 'task_done', task_id: taskId });

    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  // Handles request for the initial list of tasks
  handleGetTasks() {
      const activeTasks = Array.from(this.tasks.entries()).map(([taskId, task]) => ({
        task_id: taskId,
        raw_request: task.rawRequest,
      }));
      return new Response(JSON.stringify(activeTasks), {
          headers: { 'Content-Type': 'application/json' },
      });
  }

  // Manages a new WebSocket connection
  async handleWebSocket(server) {
    server.accept();
    this.clients.add(server);

    server.addEventListener('close', () => {
      this.clients.delete(server);
    });
    server.addEventListener('error', () => {
      this.clients.delete(server);
    });
  }
}

// The main worker entrypoint.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve the admin panel UI for the root path
    if (url.pathname === '/') {
      return new Response(adminHTML, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // For all other paths (API, WebSocket), get the Durable Object.
    // We use a fixed ID to ensure all requests hit the same DO instance.
    const id = env.TASK_ROOM.idFromName('singleton-task-room');
    const stub = env.TASK_ROOM.get(id);

    // Forward the request to the Durable Object.
    return stub.fetch(request);
  },
};

// The HTML for the admin panel.
const adminHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Manual AI Reply</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background-color: #f4f6f8; color: #333; }
        .container { max-width: 900px; margin: 20px auto; padding: 20px; }
        h1, h2 { color: #111; border-bottom: 1px solid #ddd; padding-bottom: 10px; }
        .task { background-color: #fff; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 20px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .task-id { font-size: 0.8em; color: #888; font-family: monospace; margin-bottom: 10px; }
        .request-body { white-space: pre-wrap; background-color: #eef; padding: 15px; border-radius: 5px; font-family: monospace; border: 1px solid #cce; word-break: break-all; }
        textarea { width: 100%; min-height: 120px; box-sizing: border-box; margin-top: 15px; border: 1px solid #ccc; border-radius: 4px; padding: 10px; font-size: 1em; }
        button { background-color: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; font-size: 1em; cursor: pointer; margin-top: 10px; }
        button:hover { background-color: #0056b3; }
        #ws-status { position: fixed; top: 10px; right: 10px; background-color: #ffc107; padding: 5px 10px; border-radius: 12px; font-size: 0.8em; }
        #ws-status.connected { background-color: #28a745; color: white; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Manual AI Reply</h1>
        <div id="ws-status">Connecting...</div>
        <h2>Pending Tasks</h2>
        <div id="tasks-container">
            <p>No pending tasks. Waiting for new requests...</p>
        </div>
    </div>

    <script>
        const tasksContainer = document.getElementById('tasks-container');
        const wsStatus = document.getElementById('ws-status');
        let ws;

        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${window.location.host}/\`;
            
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('WebSocket connected');
                wsStatus.textContent = 'Connected';
                wsStatus.classList.add('connected');
            };

            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                if (message.type === 'new_task') {
                    addTaskToUI(message.task_id, message.raw_request);
                } else if (message.type === 'task_done') {
                    removeTaskFromUI(message.task_id);
                }
            };

            ws.onclose = () => {
                console.log('WebSocket disconnected. Reconnecting...');
                wsStatus.textContent = 'Disconnected';
                wsStatus.classList.remove('connected');
                setTimeout(connect, 2000); // Attempt to reconnect every 2 seconds
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                ws.close();
            };
        }

        function addTaskToUI(taskId, rawRequest) {
            // If the "no tasks" message is present, remove it
            const noTasksP = tasksContainer.querySelector('p');
            if (noTasksP) {
                noTasksP.remove();
            }

            const taskElement = document.createElement('div');
            taskElement.className = 'task';
            taskElement.id = \`task-\${taskId}\`;
            
            // Try to parse the raw request as JSON for pretty printing
            let formattedRequest = rawRequest;
            try {
                const parsed = JSON.parse(rawRequest);
                formattedRequest = JSON.stringify(parsed, null, 2);
            } catch (e) {
                // Not valid JSON, just display as is
            }

            taskElement.innerHTML = \`
                <div class="task-id">ID: \${taskId}</div>
                <strong>Request Body:</strong>
                <pre class="request-body">\${escapeHtml(formattedRequest)}</pre>
                <textarea placeholder="Type your reply here..."></textarea>
                <button>Send Reply</button>
            \`;

            tasksContainer.prepend(taskElement);

            taskElement.querySelector('button').addEventListener('click', async () => {
                const reply = taskElement.querySelector('textarea').value;
                await sendReply(taskId, reply);
            });
        }
        
        function escapeHtml(unsafe) {
            return unsafe
                 .replace(/&/g, "&")
                 .replace(/</g, "<")
                 .replace(/>/g, ">")
                 .replace(/"/g, """)
                 .replace(/'/g, "&#039;");
        }


        function removeTaskFromUI(taskId) {
            const taskElement = document.getElementById(\`task-\${taskId}\`);
            if (taskElement) {
                taskElement.remove();
            }
            if (tasksContainer.children.length === 0) {
                 tasksContainer.innerHTML = '<p>No pending tasks. Waiting for new requests...</p>';
            }
        }

        async function sendReply(taskId, reply) {
            try {
                const response = await fetch(\`/return/\${taskId}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reply: reply })
                });
                if (!response.ok) {
                    const error = await response.json();
                    alert(\`Error submitting reply: \${error.message}\`);
                }
            } catch (e) {
                alert(\`Network error: \${e.message}\`);
            }
        }
        
        async function fetchInitialTasks() {
            try {
                const response = await fetch('/tasks');
                if (response.ok) {
                    const tasks = await response.json();
                    tasks.forEach(task => addTaskToUI(task.task_id, task.raw_request));
                }
            } catch (e) {
                console.error("Could not fetch initial tasks:", e);
            }
        }

        // Initial load
        fetchInitialTasks();
        connect();
    </script>
</body>
</html>
`;
