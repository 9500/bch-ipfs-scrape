#!/usr/bin/env node

/**
 * Creates a sample fixture from chaingraph-result.json
 * Randomly selects 200 registries for testing purposes
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// File paths
const inputFile = join(projectRoot, 'chaingraph-result.json');
const outputFile = join(projectRoot, 'tests/fixtures/chaingraph/sample-200-registries.json');

// Fisher-Yates shuffle algorithm
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

try {
  console.log('Creating sample fixture from chaingraph-result.json...\n');

  // Read and parse input file
  console.log(`Reading: ${inputFile}`);
  const data = JSON.parse(readFileSync(inputFile, 'utf-8'));

  // Validate structure
  if (!data.data || !data.data.search_output_prefix) {
    throw new Error('Invalid chaingraph result structure');
  }

  const allRegistries = data.data.search_output_prefix;
  console.log(`Total registries found: ${allRegistries.length}`);

  // Randomly sample 200 registries
  const shuffled = shuffleArray(allRegistries);
  const sample = shuffled.slice(0, 200);
  console.log(`Sampled: ${sample.length} random registries`);

  // Create output structure matching original format
  const output = {
    data: {
      search_output_prefix: sample
    }
  };

  // Write to output file with pretty formatting
  console.log(`Writing: ${outputFile}`);
  writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');

  // Verify output
  const outputData = JSON.parse(readFileSync(outputFile, 'utf-8'));
  const outputCount = outputData.data.search_output_prefix.length;

  console.log('\n✓ Sample fixture created successfully!');
  console.log(`  Output file: ${outputFile}`);
  console.log(`  Registry count: ${outputCount}`);
  console.log(`  File size: ${(readFileSync(outputFile).length / 1024).toFixed(1)} KB`);

} catch (error) {
  console.error('Error creating sample fixture:', error.message);
  process.exit(1);
}
