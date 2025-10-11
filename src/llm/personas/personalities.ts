import fs from 'fs';
import path from 'path';

// Define the directory path
const directoryPath = path.resolve(__dirname);

// Function to get all JSON files from the directory
function getJsonFiles(): string[] {
    try {
        // Read all files in the directory
        const files = fs.readdirSync(directoryPath);

        // Filter for JSON files only
        const jsonFiles = files.filter(file => path.extname(file).toLowerCase() === '.json');

        return jsonFiles;
    } catch (error) {
        console.error('Error reading directory:', error);
        return [];
    }
}

// Get the list of JSON files
const jsonFiles = getJsonFiles();

// Import all JSON files dynamically
const importedJsonFiles: Record<string, any> = {};



// Export the list of JSON files and their contents
export const availableJsonFiles = jsonFiles;

console.log('Available JSON files:', jsonFiles);