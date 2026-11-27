const { createApp } = require('./src/app');

const PORT = process.env.PORT || 5000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Order-to-Audit System running at http://localhost:${PORT}`);
});
