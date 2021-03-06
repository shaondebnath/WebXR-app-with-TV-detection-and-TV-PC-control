importScripts('../dist/webxr-worker.js')
console.log("loaded webxr-worker.js")

var openCVready = false;

// need to load up the files for tracking the face and eyes.  WASM module has hooks to pass in 
// files to be loaded by opencv

//var sdObjectXML = "haarcascade_frontalface_default.xml"; //"cascade_cup.xml"// "haarcascade_frontalface_default.xml"
//var sdObjectXML = "cascade_palm-20stages.xml";
var sdObjectXML = "cascade_palm-downloaded.xml";//"cascade_open_palm.xml";//"haarcascade_finger.xml";


var Module = {
  preRun: [function() {
    console.log("CV preRun")
    Module.FS_createPreloadedFile('./', sdObjectXML, sdObjectXML, true, false);
  }],
  onRuntimeInitialized: function() {
        openCVready = true;
        postMessage({type: "cvReady"});
  },
  setStatus: function(msg) {
        postMessage({type: "cvStatus", msg: msg});
  }
};
console.log("set up pre-load")

importScripts('opencv.js')
console.log("loaded opencv.js:" + cv);

var sdObject_cascade;

function loadSDObjectDetectTrainingSet() {
    if (sdObject_cascade == undefined) {
        sdObject_cascade = new cv.CascadeClassifier();
        let load = sdObject_cascade.load(sdObjectXML);
        console.log('load object detection training data', load);
    }
}


function sdObjectDetect(img_gray, roiRect) {
    loadSDObjectDetectTrainingSet();

    var roi_gray = img_gray
    if (roiRect) {
        roi_gray = img_gray.roi(roiRect);
    } else {
        roiRect = new cv.Rect(0, 0, img_gray.cols, img_gray.rows);
    }

    let sdObjects = new cv.RectVector();
    let s1 = new cv.Size(15,15);
    let s2 = new cv.Size(120,120);
    sdObject_cascade.detectMultiScale(roi_gray, sdObjects, 1.3, 3, 0, s1, s2);

    let rects = [];

    for (let i = 0; i < sdObjects.size(); i += 1) {
        let sdObjectRect = sdObjects.get(i);
        rects.push({
            x: sdObjectRect.x + roiRect.x,
            y: sdObjectRect.y + roiRect.y,
            width: sdObjectRect.width,
            height: sdObjectRect.height
        });
    }

    if (roi_gray != img_gray) roi_gray.delete()
    sdObjects.delete();
    return rects;
}



var rotatedImage = null;
var img_gray = null;
var img_rgba = null;
var resizedImage = null;

function createCVMat2(rotation, buffer, pixelFormat) {
    var width = buffer.size.width
    var height = buffer.size.height

    if (!img_gray) img_gray = new cv.Mat();
    if (!img_rgba) img_rgba = new cv.Mat();
    if (!rotatedImage) rotatedImage = new cv.Mat();

    switch(pixelFormat) {
        case XRVideoFrame.IMAGEFORMAT_YUV420P:
            var b = new Uint8Array(buffer.buffer);
            img_gray.create(height,width,cv.CV_8U)
            img_gray.data.set(b);        
            break;
        case XRVideoFrame.IMAGEFORMAT_RGBA32:
            var b = new Uint8Array(buffer.buffer);
            img_rgba.create(height,width,cv.CV_8UC4)
            img_rgba.data.set(b);
            cv.cvtColor(img_rgba, img_gray, cv.COLOR_RGBA2GRAY, 0);
            break;
    }

    // face tracker only works if image is upright.
    // on mobile, the camera is fixed, even though the display rotates.  So, we need
    // to rotate the image so it's in the right orientation (upright, relative to how the 
    // user sees it)
    switch(rotation) {
        case -90:
            cv.rotate(img_gray, rotatedImage, cv.ROTATE_90_CLOCKWISE);
            return rotatedImage;
            break;
        case 90:
            cv.rotate(img_gray, rotatedImage, cv.ROTATE_90_COUNTERCLOCKWISE);
            return rotatedImage;
            break;
        case 180:
            cv.rotate(img_gray, rotatedImage, cv.ROTATE_180);
            return rotatedImage;
            break;
        default:
            return img_gray;            
    }
}

///////////
var endTime = 0;

self.addEventListener('message',  function(event){
    // send back some timing messages, letting the main thread know the message is 
    // received and CV processing has started
    postMessage({type: "cvStart", time: ( performance || Date ).now()});

    // create a videoFrame object frome the message.  Eventually, this may
    // be passed in by the browser, if we create something like a "vision worker"
    var videoFrame = XRVideoFrame.createFromMessage(event);

    // did we find any?

    var sdObjectRects = []

    // don't do anything until opencv.js and WASM and support files are loaded
    if (openCVready) {   

        // deal with the video formats we know about
        switch (videoFrame.pixelFormat) {
        case XRVideoFrame.IMAGEFORMAT_YUV420P:
        case XRVideoFrame.IMAGEFORMAT_RGBA32:
            var scale = 1;
            var buffer = videoFrame.buffer(0);
            var width = buffer.size.width;
            var height = buffer.size.height;

            // let's pick a size such that the video is below 256 in size in both dimensions
            // since face detection is really expensive on large images
            while (width > 256 || height > 256) {
                width = width / 2
                height = height / 2
                scale = scale / 2;
            }
        
            // first, rotate the image such that it is oriented correctly relative to the display
            // since the face detector assumes the face is upright.  Also, this routine 
            // converts to 8bit grey scale
            var rotation = videoFrame.camera.cameraOrientation;
            var image = createCVMat2(rotation, videoFrame.buffer(0), videoFrame.pixelFormat)
            postMessage({type: "cvAfterMat", time: ( performance || Date ).now()});

            // did we decide to scale?
            if (scale != 1) {
                if (!resizedImage) resizedImage = new cv.Mat();

                cv.resize(image, resizedImage, new cv.Size(), scale, scale);
                postMessage({type: "cvAfterResize", time: ( performance || Date ).now()});
        
                // now find faces / objects
                sdObjectRects = sdObjectDetect(resizedImage);
                for (let i = 0; i < sdObjectRects.length; i++) {
                    let rect = sdObjectRects[i];
                    rect.x = rect.x / scale
                    rect.y = rect.y / scale
                    rect.width = rect.width / scale
                    rect.height = rect.height / scale
                }
                console.log("worker: "+sdObjectRects.length)

            } else {
                // no resize?  Just use the original image
                postMessage({type: "cvAfterResize", time: ( performance || Date ).now()});
                sdObjectRects = sdObjectDetect(image);
            }
        }
    }
    endTime = ( performance || Date ).now()
    console.log("xml:" + sdObjectXML)
    //-videoFrame.postReplyMessage({type: "cvFrame", faceRects: faceRects, time: endTime})
    videoFrame.postReplyMessage({type: "cvFrame", sdObjectRects: sdObjectRects, sdObjectXML:sdObjectXML, time: endTime})
    
    videoFrame.release();
});
