const express = require('express');
const monitor = require('./monitor');
const path = require('path');          // add this

const app = express();

app.use(monitor.middleware);
app.use('/monitor', monitor.router);

// add this line — serve dashboard.html
app.use(express.static(path.join(__dirname)));

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello World' });
});

app.listen(4000, () => console.log('Server running on http://localhost:4000'));