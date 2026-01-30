const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('./config/morgan');
const routes = require('./routes');
const { errorHandler } = require('./middlewares/error');

const app = express();

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan);
}

// set security HTTP headers
app.use(helmet());

// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

// enable cors
app.use(cors());

// v1 api routes
app.use('/v1', routes);

// for report rendering
app.use('/reports', require('./routes/report.routes'));


// send back a 404 error for any unknown api request
app.use((req, res, next) => {
  const error = new Error('Not found');
  error.statusCode = 404;
  next(error);
});

// handle error
app.use(errorHandler);

module.exports = app;
