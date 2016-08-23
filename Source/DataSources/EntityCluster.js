/*global define*/
define([
    '../Core/BoundingRectangle',
    '../Core/Cartesian2',
    '../Core/Cartesian3',
    '../Core/defaultValue',
    '../Core/defined',
    '../Core/destroyObject',
    '../Core/EllipsoidalOccluder',
    '../Core/Matrix4',
    '../Scene/Billboard',
    '../Scene/HorizontalOrigin',
    '../Scene/LabelCollection',
    '../Scene/SceneTransforms',
    '../Scene/VerticalOrigin',
    '../ThirdParty/kdbush'
], function(
    BoundingRectangle,
    Cartesian2,
    Cartesian3,
    defaultValue,
    defined,
    destroyObject,
    EllipsoidalOccluder,
    Matrix4,
    Billboard,
    HorizontalOrigin,
    LabelCollection,
    SceneTransforms,
    VerticalOrigin,
    kdbush) {
    'use strict';

    function getX(point) {
        return point.coord.x;
    }

    function getY(point) {
        return point.coord.y;
    }

    function getLabelBoundingBox(label, coord, pixelRange) {
        // TODO: create this at label creation time
        var width = 0;
        var height = Number.NEGATIVE_INFINITY;

        var glyphs = label._glyphs;
        var length = glyphs.length;
        for (var i = 0; i < length; ++i) {
            var glyph = glyphs[i];
            var billboard = glyph.billboard;
            if (!defined(billboard)) {
                continue;
            }

            width += billboard.width;
            height = Math.max(height, billboard.height);
        }

        var scale = label.scale;
        width *= scale;
        height *= scale;

        var x = coord.x;
        if (label.horizontalOrigin === HorizontalOrigin.RIGHT) {
            x -= width;
        } else if (label.horizontalOrigin === HorizontalOrigin.CENTER) {
            x -= width * 0.5;
        }

        var y = coord.y;
        if (label.verticalOrigin === VerticalOrigin.TOP) {
            y -= height;
        } else if (label.verticalOrigin === VerticalOrigin.CENTER) {
            y -= height * 0.5;
        }

        x += pixelRange;
        y += pixelRange;
        width += pixelRange * 0.5;
        height += pixelRange * 0.5;

        return new BoundingRectangle(x, y, width, height);
    }

    function cloneLabel(label) {
        return {
            text : label.text,
            show : label.show,
            font : label.font,
            fillColor : label.fillColor,
            outlineColor : label.outlineColor,
            outlineWidth : label.outlineWidth,
            style : label.outlineStyle,
            verticalOrigin : label.verticalOrigin,
            horizontalOrigin : label.horizontalOrigin,
            pixelOffset : label.pixelOffset,
            eyeOffset : label.eyeOffset,
            position : label.position,
            scale : label.scale,
            id : label.id,
            translucencyByDistance : label.translucencyByDistance,
            pixelOffsetScaleByDistance : label.pixelOffsetScaleByDistance,
            heightReference : label.heightReference
        };
    }

    function createDeclutterCallback(entityCluster) {
        return function(amount) {
            if (defined(amount) && amount < 0.05) {
                return;
            }

            var scene = entityCluster._scene;

            var labelCollection = entityCluster._labelCollection;
            var renderCollection = entityCluster._renderCollection;

            if (!defined(labelCollection)) {
                return;
            }

            var pixelRange = entityCluster._pixelRange;

            var clusters = entityCluster._previousClusters;
            var newClusters = [];

            var previousHeight = entityCluster._previousHeight;
            var currentHeight = scene.camera.positionCartographic.height;

            if (defined(renderCollection)) {
                renderCollection.removeAll();
            } else {
                renderCollection = new LabelCollection({
                    scene : scene
                });
            }

            var ellipsoid = scene.mapProjection.ellipsoid;
            var cameraPosition = scene.camera.positionWC;
            var occluder = new EllipsoidalOccluder(ellipsoid, cameraPosition);

            var i;
            var label;
            var coord;
            var length = labelCollection.length;
            var points = [];

            for (i = 0; i < length; ++i) {
                label = labelCollection.get(i);
                if (!occluder.isPointVisible(label.position)) {
                    continue;
                }

                coord = label.computeScreenSpacePosition(scene);
                if (!defined(coord) || coord.x < 0.0 || coord.x > scene.drawingBufferWidth || coord.y < 0.0 || coord.y > scene.drawingBufferHeight) {
                    continue;
                }

                points.push({
                    labelIndex : i,
                    clustered : false,
                    coord : coord
                });
            }

            var j;
            var bbox;
            var neighbors;
            var neighborLength;
            var neighborIndex;
            var neighborPoint;
            var ids;
            var numPoints;

            var index = kdbush(points, getX, getY, 64, Int32Array);

            if (currentHeight <= previousHeight) {
                length = clusters.length;
                for (i = 0; i < length; ++i) {
                    var cluster = clusters[i];

                    if (!occluder.isPointVisible(cluster.position)) {
                        continue;
                    }

                    coord = Billboard._computeScreenSpacePosition(Matrix4.IDENTITY, cluster.position, Cartesian3.ZERO, Cartesian2.ZERO, scene);
                    if (!defined(coord) || coord.x < 0.0 || coord.x > scene.drawingBufferWidth || coord.y < 0.0 || coord.y > scene.drawingBufferHeight) {
                        continue;
                    }

                    neighbors = index.within(coord.x, coord.y, cluster.radius);
                    neighborLength = neighbors.length;
                    numPoints = 0;
                    ids = [];

                    for (j = 0; j < neighborLength; ++j) {
                        neighborIndex = neighbors[j];
                        neighborPoint = points[neighborIndex];
                        if (!neighborPoint.clustered) {
                            neighborPoint.clustered = true;
                            ++numPoints;

                            ids.push(labelCollection.get(neighborPoint.labelIndex));
                        }
                    }

                    if (numPoints > 1) {
                        newClusters.push(cluster);
                        renderCollection.add({
                            text : '' + numPoints,
                            position : cluster.position,
                            id : ids
                        });
                    }
                }
            }

            length = points.length;
            for (i = 0; i < length; ++i) {
                var point = points[i];
                if (point.clustered) {
                    continue;
                }

                point.clustered = true;

                label = labelCollection.get(point.labelIndex);
                bbox = getLabelBoundingBox(label, point.coord, pixelRange);

                neighbors = index.within(bbox.x, bbox.y, bbox.width);
                neighborLength = neighbors.length;

                var clusterPosition = Cartesian3.clone(label.position);
                numPoints = 1;
                ids = [];

                for (j = 0; j < neighborLength; ++j) {
                    neighborIndex = neighbors[j];
                    neighborPoint = points[neighborIndex];
                    if (!neighborPoint.clustered) {
                        neighborPoint.clustered = true;

                        var neighborLabel = labelCollection.get(neighborPoint.labelIndex);
                        Cartesian3.add(clusterPosition, neighborLabel.position, clusterPosition);
                        BoundingRectangle.union(bbox, getLabelBoundingBox(neighborLabel, neighborPoint.coord, pixelRange), bbox);
                        ++numPoints;

                        ids.push(labelCollection.get(neighborPoint.labelIndex));
                    }
                }

                if (numPoints === 1) {
                    renderCollection.add(cloneLabel(label));
                } else {
                    var position = Cartesian3.multiplyByScalar(clusterPosition, 1.0 / numPoints, clusterPosition);
                    renderCollection.add({
                        text : '' + numPoints,
                        position : position,
                        id : ids
                    });

                    newClusters.push({
                        position : position,
                        radius : Math.max(bbox.width, bbox.height) * 0.5
                    });
                }
            }

            if (renderCollection.length === 0) {
                renderCollection.destroy();
                renderCollection = undefined;
            }

            entityCluster._renderCollection = renderCollection;
            entityCluster._previousClusters = newClusters;
            entityCluster._previousHeight = currentHeight;
        };
    }

    function EntityCluster(options) {
        this._scene = options.scene;
        this._pixelRange = defaultValue(options.pixelRange, 5);

        this._labelCollection = undefined;
        this._renderCollection = undefined;

        this._previousClusters = [];
        this._previousHeight = undefined;

        this._removeEventListener = this._scene.camera.changed.addEventListener(createDeclutterCallback(this));
    }

    EntityCluster.prototype.getLabel = function(entity) {
        if (defined(this._labelCollection) && defined(entity._labelIndex)) {
            return this._labelCollection.get(entity._labelIndex);
        }

        if (!defined(this._labelCollection)) {
            this._labelCollection = new LabelCollection({
                scene : this._scene
            });
        }

        var label = this._labelCollection.add();
        entity._labelIndex = this._labelCollection.length - 1;
        return label;
    };

    EntityCluster.prototype.remove = function(entity) {
        if (!defined(this._labelCollection) || !defined(entity._labelIndex)) {
            return;
        }

        var label = this._labelCollection.get(entity._labelIndex);
        label.show = false;
    };

    EntityCluster.prototype.update = function(frameState) {
        if (!defined(this._labelCollection)) {
            return;
        }

        if (!defined(this._renderCollection)) {
            this._labelCollection.update(frameState);
        } else {
            this._renderCollection.update(frameState);
        }
    };

    EntityCluster.prototype.isDestroyed = function() {
        return false;
    };

    EntityCluster.prototype.destroy = function() {
        this._labelCollection = this._labelCollection && this._labelCollection.destroy();
        this._removeEventListener();
        return destroyObject(this);
    };

    return EntityCluster;
});