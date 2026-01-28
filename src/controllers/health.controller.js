const checkHealth = (req, res) => {
  res.status(200).send({ status: 'ok', timestamp: new Date().toISOString() });
};

module.exports = {
  checkHealth,
};
