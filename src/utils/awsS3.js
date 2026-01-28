const fs = require('fs');
const AWS = require('aws-sdk');
let uploadToS3 = async (path, contentType, outputFilePath) => {
    const s3 = new AWS.S3(config.aws.s3);
    const CHUNK_SIZE = 10000000; // 10MB
    const isProduction = process.env.NODE_ENV === 'production';
    const params = {
        Bucket: config.aws.s3.bucket,
        Body: fs.createReadStream(outputFilePath, {
            highWaterMark: CHUNK_SIZE,
        }),
        Key: path,
        ContentType: contentType,
        CacheControl: isProduction ? 'public,  max-age=604800' : 'no-cache, no-store, must-revalidate',
    };

    try {
        const result = await s3.upload(params).promise();
        if (fs.existsSync(outputFilePath)) {
            fs.unlinkSync(outputFilePath);
        } else {
            console.warn(`⚠️ Tried to delete missing file: ${outputFilePath}`);
        }
        return result;
    } catch (err) {
        console.error('Error uploading to S3:', err);
        throw err;
    }
};

module.exports = {
    uploadToS3,
};
