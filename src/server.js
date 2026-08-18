const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n  🚀  Universal Downloader running at http://localhost:${PORT}\n`);
});
