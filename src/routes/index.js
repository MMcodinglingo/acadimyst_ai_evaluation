const express = require('express');
const healthRoute = require('./health.route');

const ieltsEvaluationRoute = require('./ieltsEvaluation.route');

const router = express.Router();

const defaultRoutes = [
  {
    path: '/health',
    route: healthRoute,
  },
  {
    path: '/ielts',
    route: ieltsEvaluationRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

module.exports = router;
