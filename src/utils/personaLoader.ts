// src/utils/personaLoader.ts
// Shared utility for loading persona files with consistent error handling

import { availableJsonFiles } from "../llm/personalities";

/**
 * Loads a persona file and returns its JSON content as a string.
 * Handles errors consistently across the application.
 * 
 * @param filename - The persona filename (e.g., "granny.json")
 * @returns Promise resolving to the JSON-stringified persona content
 * @throws Error if the file is not available or cannot be loaded
 */
export async function loadPersonaFile(filename: string): Promise<string> {
  // Validate filename
  const trimmed = filename.trim();
  if (!trimmed) {
    throw new Error("Persona filename is required.");
  }

  // Check if persona is available
  if (!availableJsonFiles.includes(trimmed)) {
    throw new Error(
      `Persona "${trimmed}" is not available. Available personas: ${availableJsonFiles.join(", ")}`
    );
  }

  try {
    // Import the persona file using dynamic import with JSON assertion
    const imported = await import(`../llm/personas/${trimmed}`, { 
      with: { type: "json" } 
    }).then((mod) => mod.default ?? mod);

    // Convert to JSON string for consistent handling
    const jsonString = JSON.stringify(imported);
    
    if (!jsonString || jsonString === "null" || jsonString === "undefined") {
      throw new Error(`Persona file "${trimmed}" loaded but contains no valid data.`);
    }

    return jsonString;
  } catch (error) {
    // Re-throw with more context if it's not already our error
    if (error instanceof Error && error.message.includes("not available")) {
      throw error;
    }
    
    // Handle import/parsing errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load persona "${trimmed}": ${errorMessage}`
    );
  }
}

/**
 * Attempts to load a persona file, returning null on failure instead of throwing.
 * Useful for optional persona loading scenarios.
 * 
 * @param filename - The persona filename (e.g., "granny.json")
 * @returns Promise resolving to the JSON-stringified persona content, or null on failure
 */
export async function loadPersonaFileSafe(filename: string): Promise<string | null> {
  try {
    return await loadPersonaFile(filename);
  } catch (error) {
    console.warn(
      `Failed to load persona "${filename}":`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}