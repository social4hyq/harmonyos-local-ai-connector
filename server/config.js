const config = {
  API_PORT: parseInt(process.env.API_PORT, 10) || 11435,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT, 10) || 120000,
};

module.exports = config;
