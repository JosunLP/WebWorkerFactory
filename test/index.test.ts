import WebWorkerWrapper from "../src/WorkerFacotry.js";


/**
 * The main function to be executed within Web Workers.
 * @param inputArray The input data array.
 * @returns The result of processing the input data.
 */
function workerFunction(inputArray: number[]): number {
  let result = 0;
  for (let i = 0; i < inputArray.length; i++) {
    result += inputArray[i];
  }
  return result;
}



// Verwendung des WebWorkerWrappers mit dynamischem Ressourcenmanagement
const numCores = navigator.hardwareConcurrency || 2; // Default to 2 if unknown
const wrapper = new WebWorkerWrapper(workerFunction, numCores); // Erstelle Pool mit der Anzahl der Kerne

// Periodisch die Worker-Anzahl basierend auf Ressourcen anpassen
const _ = setInterval(() => {
  wrapper.adjustWorkersToResources();
}, 5000); // Anpassung alle 5 Sekunden

// Wenn du fertig bist, kannst du das Anpassungsintervall löschen
// clearInterval(adjustInterval);

(async () => {
  const largeDataArray = Array.from(
    { length: 1000000 },
    (_, index) => index + 1
  );
  const chunkSize = 1000;

  try {
    const results = await wrapper.runParallel(largeDataArray, chunkSize, 5000); // Führe parallele Verarbeitung aus
    console.log("Results:", results);
  } catch (error) {
    console.error("Error:", error);
  }
})();