#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>

static id StringOrNull(NSString *value) {
    return value.length > 0 ? value : [NSNull null];
}

int main(void) {
    @autoreleasepool {
        char input[256];
        if (fgets(input, sizeof(input), stdin) == NULL) return 2;

        double latitude;
        double longitude;
        if (sscanf(input, "%lf %lf", &latitude, &longitude) != 2) return 2;
        if (!isfinite(latitude) || !isfinite(longitude) || fabs(latitude) > 90 || fabs(longitude) > 180) return 2;

        CLLocation *location = [[CLLocation alloc] initWithLatitude:latitude longitude:longitude];
        CLGeocoder *geocoder = [[CLGeocoder alloc] init];
        __block BOOL finished = NO;
        __block NSDictionary *result = nil;

        [geocoder reverseGeocodeLocation:location completionHandler:^(NSArray<CLPlacemark *> *placemarks, NSError *error) {
            if (error) {
                result = @{ @"error": error.localizedDescription ?: @"geocoding failed" };
            } else if (placemarks.count == 0) {
                result = @{ @"error": @"no placemarks" };
            } else {
                CLPlacemark *placemark = placemarks.firstObject;
                result = @{
                    @"name": StringOrNull(placemark.name),
                    @"thoroughfare": StringOrNull(placemark.thoroughfare),
                    @"subThoroughfare": StringOrNull(placemark.subThoroughfare),
                    @"locality": StringOrNull(placemark.locality),
                    @"subLocality": StringOrNull(placemark.subLocality),
                    @"administrativeArea": StringOrNull(placemark.administrativeArea),
                    @"subAdministrativeArea": StringOrNull(placemark.subAdministrativeArea),
                    @"postalCode": StringOrNull(placemark.postalCode),
                    @"country": StringOrNull(placemark.country)
                };
            }
            finished = YES;
        }];

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
        while (!finished && deadline.timeIntervalSinceNow > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                     beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }

        if (!finished) result = @{ @"error": @"timeout" };
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        return finished && result[@"error"] == nil ? 0 : 1;
    }
}
