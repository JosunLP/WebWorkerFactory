/**
 * Represents a wrapper for managing and utilizing Web Workers for parallel processing.
 */
export default class WebWorkerWrapper {
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private isPaused: boolean = false;
  private isRunning: boolean = false;
  private pausePromise: Promise<void> | null = null;
  private resolvePausePromise: (() => void) | null = null;
  private activeTasks: Map<
    number,
    { resolve: (result: any) => void; reject: (error: any) => void }
  > = new Map();
  private nextTaskId: number = 1;
  private errorHandler: ((error: any) => void) | null = null; // Optional error handler
  private busyWorkers: Set<Worker> = new Set(); // Set to keep track of busy workers
  private workerFunction: Function;

  /**
   * Creates an instance of WebWorkerWrapper.
   * @param workerFunction The function to be executed within the Web Workers.
   * @param numWorkers The number of Web Workers to create in the pool.
   * @param errorHandler An optional error handler function.
   */
  constructor(
    workerFunction: Function,
    numWorkers: number = 1,
    errorHandler: ((error: any) => void) | null = null
  ) {
    this.errorHandler = errorHandler;
    this.workerFunction = workerFunction;

    for (let i = 0; i < numWorkers; i++) {
      this.workers.push(this.createWorker(workerFunction));
    }
    this.availableWorkers = [...this.workers]; // Initially, all workers are available
  }

  /**
   * Creates worker with the specified function.
   * @param workerFunction
   * @returns worker
   */
  private createWorker(workerFunction: Function): Worker {
    const errorHandlerCode = this.errorHandler
      ? `
      self.onerror = function(event) {
        const errorMessage = event.message;
        const errorStack = event.error ? event.error.stack : null;
        postMessage({ type: 'error', errorMessage, errorStack });
      };
      `
      : "";

    const workerCode = `
      let isPaused = false;
      let taskQueue = [];
      
      ${errorHandlerCode}

      self.onmessage = function(e) {
        if (e.data.type === 'pause') {
          isPaused = true;
          postMessage({ type: 'paused' });
        } else if (e.data.type === 'resume') {
          isPaused = false;
          processQueue();
          postMessage({ type: 'resumed' });
        } else if (e.data.type === 'run') {
          if (isPaused) {
            enqueueTask(e.data.input);
          } else {
            const result = (${workerFunction.toString()})(e.data.input);
            postMessage({ type: 'result', result, taskId: e.data.taskId });
          }
        } else if (e.data.type === 'getProgress') {
          postMessage({ type: 'progress', progress: taskQueue.length });
        }
      };

      function enqueueTask(input) {
        taskQueue.push(input);
      }

      function processQueue() {
        while (taskQueue.length > 0 && !isPaused) {
          const input = taskQueue.shift();
          const result = (${workerFunction.toString()})(input);
          postMessage({ type: 'result', result, taskId: Math.random() });
        }
      }
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const worker = new Worker(URL.createObjectURL(blob));
    return worker;
  }

  /**
   * Setups message listeners for the workers.
   */
  private setupMessageListeners(worker: Worker) { // Parameter hinzugefügt
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "paused") {
        if (this.resolvePausePromise) {
          this.resolvePausePromise();
          this.resolvePausePromise = null;
          this.pausePromise = null;
        }
      } else if (e.data.type === "resumed") {
        this.processQueue();
      } else if (e.data.type === "result") {
        console.log("Worker result:", e.data.result);
        if (this.isRunning) {
          this.processQueue();
        }
        const task = this.activeTasks.get(e.data.taskId);
        if (task) {
          task.resolve(e.data.result);
          this.activeTasks.delete(e.data.taskId);

          // Mark the worker as available after completing the task
          this.availableWorkers.push(worker);

          // Remove the worker from the busy set
          this.busyWorkers.delete(worker);

          // Continue processing the queue
          this.processQueue();
        }
      } else if (e.data.type === "progress") {
        console.log("Worker progress:", e.data.progress);
      } else if (e.data.type === "error") {
        const task = this.activeTasks.get(e.data.taskId);
        if (task) {
          task.reject(e.data.error);
          this.activeTasks.delete(e.data.taskId);
        }
      }
    };
  }

  /**
   * Process queue.
   */
  private processQueue() {
    this.isRunning = true;
    for (const worker of this.availableWorkers) {
      if (!this.isPaused) {
        worker.postMessage({ type: "resume" });
      }
    }
  }

  /**
   * Handles worker error.
   * @param error
   */
  private handleWorkerError(error: any) {
    console.error("Worker error:", error);
    // Füge hier deine Fehlerbehandlungslogik hinzu, z.B. Pausiere die Worker, informiere den Benutzer usw.
  }

  /**
   * Adds worker.
   */
  private addWorker() {
    const newWorker = this.createWorker(this.workerFunction);
    this.workers.push(newWorker);
    if (!this.isPaused) {
      this.availableWorkers.push(newWorker);
      newWorker.postMessage({ type: "resume" });
    }
    this.setupMessageListeners(newWorker);
  }

  /**
   * Removes worker
   */
  private removeWorker() {
    const removedWorker = this.availableWorkers.pop();
    if (removedWorker) {
      removedWorker.postMessage({ type: "pause" });
      removedWorker.terminate();
      const index = this.workers.indexOf(removedWorker);
      if (index !== -1) {
        this.workers.splice(index, 1);
      }
    }
  }

  /**
   * Runs the specified function within a Web Worker and returns a promise with the result.
   * @param input The input data for the function.
   * @param timeout The timeout for the task in milliseconds.
   * @returns A promise that resolves with the result of the task.
   */
  public async run(input: any, timeout: number = 0): Promise<any> {
    if (!this.isPaused) {
      const availableWorker = this.availableWorkers.pop();
      if (availableWorker) {
        // Mark the worker as busy
        this.busyWorkers.add(availableWorker);
        return new Promise((resolve, reject) => {
          const taskId = this.nextTaskId++;
          this.activeTasks.set(taskId, { resolve, reject });

          availableWorker.postMessage({ type: "run", input, taskId });

          if (timeout > 0) {
            setTimeout(() => {
              const task = this.activeTasks.get(taskId);
              if (task) {
                task.reject("Task timed out");
                this.activeTasks.delete(taskId);
              }
            }, timeout);
          }
        });
      }
    } else {
      this.pausePromise = new Promise<void>((resolve) => {
        this.resolvePausePromise = resolve;
      });
      for (const worker of this.availableWorkers) {
        worker.postMessage({ type: "pause" });
      }
      return this.pausePromise.then(() => {
        return this.run(input, timeout);
      });
    }

    return Promise.reject("No worker available");
  }

  /**
   * Runs the specified function within a Web Worker and reports progress.
   * @param input The input data for the function.
   * @param progressCallback A callback function to report progress.
   */
   public runWithProgress(
    input: any,
    progressCallback: (progress: number) => void
  ) {
    this.isRunning = true;

    const progressInterval = setInterval(() => {
      for (const worker of this.availableWorkers) {
        if (!this.isPaused) {
          worker.postMessage({ type: "getProgress" });
        }
      }
    }, 1000); // Alle 1 Sekunde

    const cleanup = () => {
      clearInterval(progressInterval);
    };

    const handleProgressMessage = (e: MessageEvent) => {
      if (e.data.type === "progress") {
        progressCallback(e.data.progress);
      }
    };

    for (const worker of this.availableWorkers) {
      worker.postMessage({ type: "runWithProgress", input });
      worker.addEventListener("message", handleProgressMessage);
      worker.addEventListener("error", (e: ErrorEvent) => {
        this.handleWorkerError(e.error);
      });
    }
  }

  /**
   * Pauses the execution of tasks within the Web Workers.
   */
  public pause() {
    this.isPaused = true;
  }

  /**
   * Resumes the execution of tasks within the Web Workers.
   */
  public resume() {
    this.isPaused = false;
    if (this.resolvePausePromise) {
      this.resolvePausePromise();
      this.resolvePausePromise = null;
      this.pausePromise = null;
    }
    this.processQueue();
  }

  /**
   * Terminates all Web Workers in the pool.
   */
  public terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
  }

  /**
   * Waits for the Web Workers to be paused.
   * @returns A promise that resolves when all workers are paused.
   */
  public waitForPause() {
    return this.pausePromise;
  }

  /**
   * Adds a worker to the pool if needed.
   */
  public addWorkerIfNeeded() {
    if (this.availableWorkers.length === 0) {
      this.addWorker();
    }
  }

  /**
   * Removes an idle worker from the pool if needed.
   */
  public removeIdleWorkerIfNeeded() {
    if (this.availableWorkers.length > 1) {
      this.removeWorker();
    }
  }

  /**
   * Runs tasks in parallel using the specified chunk size.
   * @param inputArray The array of input data to be processed.
   * @param chunkSize The size of each processing chunk.
   * @param timeout The timeout for each task in milliseconds.
   * @returns A promise that resolves with an array of results.
   */
  public async runParallel(
    inputArray: any[],
    chunkSize: number,
    timeout: number = 0
  ): Promise<any[]> {
    const results: any[] = [];
    const numChunks = Math.ceil(inputArray.length / chunkSize);

    const runChunk = async (chunkIndex: number) => {
      const startIdx = chunkIndex * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, inputArray.length);
      const chunkInput = inputArray.slice(startIdx, endIdx);

      const result = await this.run(chunkInput, timeout).catch((error) => {
        if (this.errorHandler) {
          this.errorHandler(error);
        }
        return null;
      });

      results[chunkIndex] = result;
    };

    const promises: Promise<void>[] = [];
    for (let i = 0; i < numChunks; i++) {
      promises.push(runChunk(i));
    }

    await Promise.all(promises);
    return results;
  }

  /**
   * Adjusts workers to resources.
   */
  public adjustWorkersToResources() {
    const availableCores = navigator.hardwareConcurrency || 2; // Default to 2 if unknown
    const numWorkersNeeded = Math.min(availableCores, this.workers.length + 1); // Adjust by adding one more worker
    const numWorkersToAdd = numWorkersNeeded - this.workers.length;

    if (numWorkersToAdd > 0) {
      for (let i = 0; i < numWorkersToAdd; i++) {
        this.addWorker();
      }
    } else if (numWorkersToAdd < 0) {
      for (let i = 0; i < -numWorkersToAdd; i++) {
        this.removeWorker();
      }
    }
  }
}

