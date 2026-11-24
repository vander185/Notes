import { readFileSync } from 'fs';
const src = readFileSync('tools/claire_app.js', 'utf8');
const a = src.indexOf('  meteo: async'), b = src.indexOf('  lire_notes_et_rappels:');
const tools = new Function('return {' + src.slice(a, b) + '}')();
console.log('METEO', (await tools.meteo({})).slice(0, 400));
console.log('METEO2', (await tools.meteo({ ville: 'Tanger' })).slice(0,60) + ' | ' + (await tools.meteo({ ville: 'Paris' })).slice(0, 200));
console.log('WIKI', (await tools.chercher_wikipedia({ recherche: 'Ibn Battuta' })).slice(0, 300));
